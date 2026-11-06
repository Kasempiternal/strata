#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use strata_engine::tree::{Metric, Tree};
use strata_engine::{mft, walk, winutil, Progress};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct AppState {
    tree: RwLock<Option<Tree>>,
    cancel: Mutex<Arc<AtomicBool>>,
    generation: AtomicU64,
}

type Res<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeInfo {
    id: u32,
    name: String,
    is_dir: bool,
    size: u64,
    alloc: u64,
    files: u32,
    dirs: u32,
}

fn info(t: &Tree, id: u32) -> NodeInfo {
    let i = id as usize;
    NodeInfo {
        id,
        name: t.name(id).to_string(),
        is_dir: t.is_dir(id),
        size: t.size[i],
        alloc: t.alloc[i],
        files: t.files[i],
        dirs: t.dirs[i],
    }
}

fn with_tree<T>(app: &AppHandle, f: impl FnOnce(&Tree) -> Res<T>) -> Res<T> {
    let st = app.state::<AppState>();
    let g = st.tree.read().map_err(|_| "state poisoned")?;
    let t = g.as_ref().ok_or("no scan loaded")?;
    f(t)
}

fn check(t: &Tree, id: u32) -> Res<()> {
    if t.valid(id) {
        Ok(())
    } else {
        Err(format!("unknown item {id}"))
    }
}

// ------------------------------------------------------------------ app / drives

#[tauri::command]
fn app_status() -> Value {
    json!({ "admin": winutil::is_admin(), "version": env!("CARGO_PKG_VERSION") })
}

#[tauri::command]
fn relaunch_admin(app: AppHandle) -> Res<()> {
    if winutil::relaunch_elevated() {
        app.exit(0);
        Ok(())
    } else {
        Err("Elevation was cancelled".into())
    }
}

#[tauri::command(async)]
fn list_drives() -> Vec<winutil::Drive> {
    winutil::list_drives()
}

#[tauri::command(async)]
fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose a folder to analyze")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

// ------------------------------------------------------------------ scanning

#[tauri::command]
fn start_scan(app: AppHandle, path: String) -> Res<()> {
    let st = app.state::<AppState>();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut c = st.cancel.lock().unwrap();
        c.store(true, Ordering::Relaxed); // stop any scan in flight
        *c = cancel.clone();
    }
    let generation = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    // Free the previous tree before allocating a new one.
    *st.tree.write().unwrap() = None;

    std::thread::spawn(move || run_scan(app, path, cancel, generation));
    Ok(())
}

fn run_scan(app: AppHandle, path: String, cancel: Arc<AtomicBool>, generation: u64) {
    let started = Instant::now();
    let prog = Arc::new(Progress::default());
    let finished = Arc::new(AtomicBool::new(false));

    let mut norm = path.trim().replace('/', "\\");
    if norm.len() == 2 && norm.ends_with(':') {
        norm.push('\\');
    }
    let letter = norm.chars().next().unwrap_or('C').to_ascii_uppercase();
    let is_local = norm.get(1..3) == Some(":\\");
    let drive_root = format!("{letter}:\\");
    let ntfs = is_local
        && winutil::volume_info(&drive_root)
            .map(|(_, fs)| fs.eq_ignore_ascii_case("NTFS"))
            .unwrap_or(false);
    let use_mft = ntfs && winutil::is_admin();
    prog.phase
        .store(if use_mft { 0 } else { 1 }, Ordering::Relaxed);

    // Progress ticker.
    {
        let (app, prog, finished, cancel) =
            (app.clone(), prog.clone(), finished.clone(), cancel.clone());
        std::thread::spawn(move || {
            while !finished.load(Ordering::Relaxed) && !cancel.load(Ordering::Relaxed) {
                let phase = match prog.phase.load(Ordering::Relaxed) {
                    0 => "mft",
                    1 => "walk",
                    _ => "build",
                };
                let _ = app.emit(
                    "scan-progress",
                    json!({
                        "phase": phase,
                        "done": prog.done.load(Ordering::Relaxed),
                        "total": prog.total.load(Ordering::Relaxed),
                        "files": prog.files.load(Ordering::Relaxed),
                        "bytes": prog.bytes.load(Ordering::Relaxed),
                        "elapsedMs": started.elapsed().as_millis() as u64,
                    }),
                );
                std::thread::sleep(Duration::from_millis(60));
            }
        });
    }

    let mut result = if use_mft {
        mft::scan_volume(letter, &prog, &cancel).and_then(|mut t| {
            let rel = norm[3..].trim_end_matches('\\');
            if !rel.is_empty() {
                let id = t
                    .find_relative(rel)
                    .ok_or_else(|| format!("{norm} not found on volume"))?;
                if !t.is_dir(id) {
                    return Err(format!("{norm} is not a folder"));
                }
                t.scan_root = id;
            }
            Ok(t)
        })
    } else {
        Err(String::new())
    };
    let mut mode_note = "";
    if result.is_err() && !cancel.load(Ordering::Relaxed) {
        if use_mft {
            mode_note = "mft-failed";
        }
        // Fallback / non-admin path: parallel directory walk.
        for c in [&prog.done, &prog.total, &prog.files, &prog.bytes] {
            c.store(0, Ordering::Relaxed);
        }
        prog.phase.store(1, Ordering::Relaxed);
        result = walk::scan_path(&norm, &prog, &cancel);
    }
    finished.store(true, Ordering::Relaxed);

    let st = app.state::<AppState>();
    if cancel.load(Ordering::Relaxed) || st.generation.load(Ordering::SeqCst) != generation {
        let _ = app.emit("scan-cancelled", json!({}));
        return;
    }
    match result {
        Ok(mut t) => {
            t.generation = generation;
            let r = t.scan_root as usize;
            let payload = json!({
                "rootId": t.scan_root,
                "path": t.path(t.scan_root),
                "mode": t.mode,
                "note": mode_note,
                "elapsedMs": started.elapsed().as_millis() as u64,
                "files": t.files[r],
                "dirs": t.dirs[r],
                "size": t.size[r],
                "alloc": t.alloc[r],
            });
            *st.tree.write().unwrap() = Some(t);
            let _ = app.emit("scan-done", payload);
        }
        Err(e) => {
            let _ = app.emit("scan-error", json!({ "message": e }));
        }
    }
}

#[tauri::command]
fn cancel_scan(app: AppHandle) {
    let st = app.state::<AppState>();
    st.cancel.lock().unwrap().store(true, Ordering::Relaxed);
}

// ------------------------------------------------------------------ queries

#[tauri::command(async)]
fn list_children(
    app: AppHandle,
    id: u32,
    metric: String,
    sort: Option<String>,
    limit: Option<usize>,
) -> Res<Value> {
    with_tree(&app, |t| {
        check(t, id)?;
        let m = Metric::parse(&metric);
        let limit = limit.unwrap_or(2000).max(1);
        let mut kids: Vec<u32> = t.children(id).collect();
        match sort.as_deref().unwrap_or("metric") {
            "name" => kids.sort_unstable_by(|&a, &b| {
                t.is_dir(b)
                    .cmp(&t.is_dir(a))
                    .then_with(|| t.name(a).to_lowercase().cmp(&t.name(b).to_lowercase()))
            }),
            "files" => {
                kids.sort_unstable_by(|&a, &b| t.files[b as usize].cmp(&t.files[a as usize]))
            }
            _ => kids.sort_unstable_by(|&a, &b| t.value(b, m).cmp(&t.value(a, m))),
        }
        let more = kids.len().saturating_sub(limit);
        let more_value: u64 = kids.iter().skip(limit).map(|&c| t.value(c, m)).sum();
        let children: Vec<NodeInfo> = kids.iter().take(limit).map(|&c| info(t, c)).collect();
        let crumbs: Vec<Value> = t
            .crumbs(id)
            .into_iter()
            .map(|c| json!({ "id": c, "name": t.name(c) }))
            .collect();
        Ok(json!({
            "node": info(t, id),
            "path": t.path(id),
            "crumbs": crumbs,
            "children": children,
            "more": more,
            "moreValue": more_value,
        }))
    })
}

fn burst(t: &Tree, id: u32, m: Metric, depth: u32, threshold: u64) -> Value {
    let v = t.value(id, m);
    let mut obj = json!({ "id": id, "name": t.name(id), "v": v, "isDir": t.is_dir(id) });
    if depth == 0 || !t.is_dir(id) {
        return obj;
    }
    let mut kids: Vec<u32> = t
        .children(id)
        .filter(|&c| t.value(c, m) >= threshold)
        .collect();
    kids.sort_unstable_by(|&a, &b| t.value(b, m).cmp(&t.value(a, m)));
    kids.truncate(160);
    let shown: u64 = kids.iter().map(|&c| t.value(c, m)).sum();
    let mut children: Vec<Value> = kids
        .iter()
        .map(|&c| burst(t, c, m, depth - 1, threshold))
        .collect();
    let rest = v.saturating_sub(shown);
    if rest > 0 && rest >= threshold / 2 {
        let total_kids = t.children(id).count();
        let n = total_kids.saturating_sub(kids.len());
        if n > 0 {
            children.push(json!({ "id": -1, "name": format!("{n} smaller items"), "v": rest, "isDir": false }));
        }
    }
    obj["children"] = Value::Array(children);
    obj
}

#[tauri::command(async)]
fn sunburst(
    app: AppHandle,
    id: u32,
    metric: String,
    depth: Option<u32>,
    min_fraction: Option<f64>,
) -> Res<Value> {
    with_tree(&app, |t| {
        check(t, id)?;
        let m = Metric::parse(&metric);
        let depth = depth.unwrap_or(4).clamp(1, 8);
        let frac = min_fraction.unwrap_or(0.004).clamp(0.0001, 0.2);
        let threshold = ((t.value(id, m) as f64) * frac).max(1.0) as u64;
        Ok(burst(t, id, m, depth, threshold))
    })
}

#[tauri::command(async)]
fn largest_files(app: AppHandle, id: u32, metric: String, limit: Option<usize>) -> Res<Vec<Value>> {
    with_tree(&app, |t| {
        check(t, id)?;
        let m = Metric::parse(&metric);
        Ok(t.largest_files(id, m, limit.unwrap_or(500).min(10_000))
            .into_iter()
            .map(|c| {
                let mut v = serde_json::to_value(info(t, c)).unwrap();
                v["path"] = Value::String(t.path(c));
                v
            })
            .collect())
    })
}

#[tauri::command(async)]
fn file_types(app: AppHandle, id: u32, metric: String, limit: Option<usize>) -> Res<Vec<Value>> {
    with_tree(&app, |t| {
        check(t, id)?;
        let m = Metric::parse(&metric);
        let mut v = t.file_types(id);
        v.sort_unstable_by(|a, b| match m {
            Metric::Alloc => b.3.cmp(&a.3),
            Metric::Size => b.2.cmp(&a.2),
        });
        v.truncate(limit.unwrap_or(60).max(1));
        Ok(v.into_iter().map(|(ext, count, size, alloc)| json!({ "ext": ext, "count": count, "size": size, "alloc": alloc })).collect())
    })
}

#[tauri::command(async)]
fn node_path(app: AppHandle, id: u32) -> Res<String> {
    with_tree(&app, |t| {
        check(t, id)?;
        Ok(t.path(id))
    })
}

// ------------------------------------------------------------------ actions

#[tauri::command(async)]
fn delete_items(app: AppHandle, ids: Vec<u32>, permanent: bool) -> Res<Value> {
    // 1) Resolve paths under a read lock; skip nested duplicates.
    let (generation, mut plan) = with_tree(&app, |t| {
        let mut ids: Vec<u32> = ids.into_iter().filter(|&i| t.valid(i)).collect();
        ids.sort_unstable();
        ids.dedup();
        let set: Vec<u32> = ids.clone();
        let plan: Vec<(u32, String, bool, u64)> = ids
            .iter()
            .copied()
            .filter(|&i| !set.iter().any(|&a| a != i && t.is_within(i, a)))
            .map(|i| (i, t.path(i), t.is_dir(i), t.alloc[i as usize]))
            .collect();
        Ok((t.generation, plan))
    })?;

    // 2) Touch the filesystem without holding any lock.
    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    let mut freed = 0u64;
    for (id, path, is_dir, alloc) in plan.drain(..) {
        if winutil::is_protected(&path) {
            failed.push(json!({ "id": id, "path": path, "error": "Protected system location" }));
            continue;
        }
        let r = if permanent {
            if is_dir {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            }
            .map_err(|e| e.to_string())
        } else {
            trash::delete(&path).map_err(|e| e.to_string())
        };
        match r {
            Ok(()) => {
                deleted.push(id);
                freed += alloc;
            }
            Err(e) => {
                // A partially removed folder: whatever is gone is gone; report the error.
                let gone = !std::path::Path::new(&path).exists();
                if gone {
                    deleted.push(id);
                    freed += alloc;
                } else {
                    failed.push(json!({ "id": id, "path": path, "error": e }));
                }
            }
        }
    }

    // 3) Update the tree.
    let st = app.state::<AppState>();
    if let Ok(mut g) = st.tree.write() {
        if let Some(t) = g.as_mut() {
            if t.generation == generation {
                for &id in &deleted {
                    t.remove(id);
                }
            }
        }
    }
    Ok(json!({ "deleted": deleted, "failed": failed, "freed": freed }))
}

#[tauri::command(async)]
fn reveal(app: AppHandle, id: u32) -> Res<()> {
    let p = with_tree(&app, |t| {
        check(t, id)?;
        Ok(t.path(id))
    })?;
    winutil::reveal(&p);
    Ok(())
}

#[tauri::command(async)]
fn open_item(app: AppHandle, id: u32) -> Res<()> {
    let p = with_tree(&app, |t| {
        check(t, id)?;
        Ok(t.path(id))
    })?;
    if winutil::open_item(&p) {
        Ok(())
    } else {
        Err(format!("Could not open {p}"))
    }
}

#[tauri::command(async)]
fn recycle_bin() -> Value {
    let (items, size) = winutil::recycle_bin();
    json!({ "items": items, "size": size })
}

#[tauri::command(async)]
fn empty_recycle_bin() -> Res<()> {
    winutil::empty_recycle_bin()
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            app_status,
            relaunch_admin,
            list_drives,
            pick_folder,
            start_scan,
            cancel_scan,
            list_children,
            sunburst,
            largest_files,
            file_types,
            node_path,
            delete_items,
            reveal,
            open_item,
            recycle_bin,
            empty_recycle_bin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Strata");
}
