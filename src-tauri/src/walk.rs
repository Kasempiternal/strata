//! Parallel directory walker (fallback when MFT access is unavailable, or for non-NTFS volumes).
//! Every directory becomes a rayon task; entries are enumerated with
//! `FindFirstFileExW(FindExInfoBasic, FIND_FIRST_EX_LARGE_FETCH)` which returns sizes and
//! attributes without opening any file.

use crate::tree::{RawNodes, Tree, F_DIR, NONE};
use crate::Progress;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::{
    FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
    GetCompressedFileSizeW, GetDiskFreeSpaceW, FIND_FIRST_EX_LARGE_FETCH, WIN32_FIND_DATAW,
};

const ATTR_DIRECTORY: u32 = 0x10;
const ATTR_SPARSE: u32 = 0x200;
const ATTR_REPARSE: u32 = 0x400;
const ATTR_COMPRESSED: u32 = 0x800;
const ATTR_OFFLINE: u32 = 0x1000;
const ATTR_RECALL_ON_OPEN: u32 = 0x40000;
const ATTR_RECALL_ON_DATA_ACCESS: u32 = 0x400000;

struct Rec {
    id: u32,
    parent: u32,
    name: String,
    size: u64,
    alloc: u64,
    dir: bool,
}

struct Ctx<'a> {
    next: AtomicU32,
    out: Mutex<Vec<Vec<Rec>>>,
    cluster: u64,
    prog: &'a Progress,
    cancel: &'a AtomicBool,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn cluster_size(root: &str) -> u64 {
    let w = wide(root);
    let (mut spc, mut bps, mut fc, mut tc) = (0u32, 0u32, 0u32, 0u32);
    let ok = unsafe { GetDiskFreeSpaceW(w.as_ptr(), &mut spc, &mut bps, &mut fc, &mut tc) };
    if ok != 0 && spc * bps > 0 {
        (spc * bps) as u64
    } else {
        4096
    }
}

/// `dir` is an extended-length path without trailing backslash (e.g. `\\?\C:\Users`).
fn process<'s>(s: &rayon::Scope<'s>, dir: String, id: u32, ctx: &'s Ctx<'s>) {
    if ctx.cancel.load(Ordering::Relaxed) {
        return;
    }
    let pattern = wide(&format!("{dir}\\*"));
    let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    let h = unsafe {
        FindFirstFileExW(
            pattern.as_ptr(),
            FindExInfoBasic,
            &mut data as *mut _ as *mut _,
            FindExSearchNameMatch,
            std::ptr::null(),
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };
    if h == INVALID_HANDLE_VALUE {
        return; // access denied etc. — directory stays empty
    }
    let mut recs: Vec<Rec> = Vec::new();
    let mut subdirs: Vec<(usize, String)> = Vec::new();
    let mut files = 0u64;
    let mut bytes = 0u64;
    loop {
        let nlen = data
            .cFileName
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(data.cFileName.len());
        let wname = &data.cFileName[..nlen];
        let skip = wname == [b'.' as u16] || wname == [b'.' as u16, b'.' as u16];
        if !skip {
            let name = String::from_utf16_lossy(wname);
            let attrs = data.dwFileAttributes;
            let is_dir = attrs & ATTR_DIRECTORY != 0;
            let (mut size, mut alloc) = (0u64, 0u64);
            if !is_dir {
                size = ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64;
                alloc = if attrs & (ATTR_OFFLINE | ATTR_RECALL_ON_OPEN | ATTR_RECALL_ON_DATA_ACCESS)
                    != 0
                {
                    0 // cloud placeholder: not stored locally
                } else if attrs & (ATTR_SPARSE | ATTR_COMPRESSED) != 0 {
                    let w = wide(&format!("{dir}\\{name}"));
                    let mut hi = 0u32;
                    let lo = unsafe { GetCompressedFileSizeW(w.as_ptr(), &mut hi) };
                    if lo == u32::MAX && hi == 0 {
                        size
                    } else {
                        (((hi as u64) << 32) | lo as u64).div_ceil(ctx.cluster) * ctx.cluster
                    }
                } else {
                    size.div_ceil(ctx.cluster) * ctx.cluster
                };
                files += 1;
                bytes += alloc;
            } else if attrs & ATTR_REPARSE == 0 {
                subdirs.push((recs.len(), name.clone()));
            }
            recs.push(Rec {
                id: 0,
                parent: id,
                name,
                size,
                alloc,
                dir: is_dir,
            });
        }
        if unsafe { FindNextFileW(h, &mut data) } == 0 {
            break;
        }
    }
    unsafe { FindClose(h) };

    let base = ctx.next.fetch_add(recs.len() as u32, Ordering::Relaxed);
    for (k, r) in recs.iter_mut().enumerate() {
        r.id = base + k as u32;
    }
    for (k, name) in subdirs {
        let child = recs[k].id;
        let path = format!("{dir}\\{name}");
        s.spawn(move |s| process(s, path, child, ctx));
    }
    ctx.prog.files.fetch_add(files, Ordering::Relaxed);
    ctx.prog.bytes.fetch_add(bytes, Ordering::Relaxed);
    ctx.prog.done.fetch_add(1, Ordering::Relaxed);
    if !recs.is_empty() {
        ctx.out.lock().unwrap().push(recs);
    }
}

/// Scans `path` (a drive root like `C:\` or any folder).
pub fn scan_path(path: &str, prog: &Progress, cancel: &AtomicBool) -> Result<Tree, String> {
    let trimmed = path.trim_end_matches('\\');
    let meta = std::fs::metadata(format!("{trimmed}\\")).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let drive_root: String = trimmed.chars().take(2).chain("\\".chars()).collect();
    let ctx = Ctx {
        next: AtomicU32::new(1),
        out: Mutex::new(Vec::new()),
        cluster: cluster_size(&drive_root),
        prog,
        cancel,
    };
    let ext_root = if let Some(unc) = trimmed.strip_prefix(r"\\") {
        // UNC path \\server\share -> \\?\UNC\server\share
        format!(r"\\?\UNC\{unc}")
    } else {
        format!(r"\\?\{trimmed}")
    };
    let ctx_ref = &ctx;
    rayon::scope(move |s| process(s, ext_root, 0, ctx_ref));
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    prog.phase.store(2, Ordering::Relaxed);

    let n = ctx.next.load(Ordering::Relaxed) as usize;
    let batches = ctx.out.into_inner().unwrap();
    let name_bytes: usize = batches.iter().flatten().map(|r| r.name.len()).sum();
    let mut raw = RawNodes::with_capacity(n, name_bytes);
    raw.parent.resize(n, NONE);
    raw.name_off.resize(n, 0);
    raw.name_len.resize(n, 0);
    raw.size.resize(n, 0);
    raw.alloc.resize(n, 0);
    raw.flags.resize(n, 0);
    raw.flags[0] = F_DIR;
    for r in batches.into_iter().flatten() {
        let i = r.id as usize;
        let off = raw.names.len();
        raw.names.push_str(&r.name);
        raw.parent[i] = r.parent;
        raw.name_off[i] = off as u32;
        raw.name_len[i] = (raw.names.len() - off).min(u16::MAX as usize) as u16;
        raw.size[i] = r.size;
        raw.alloc[i] = r.alloc;
        raw.flags[i] = if r.dir { F_DIR } else { 0 };
    }
    let root_name = if trimmed.len() <= 2 {
        trimmed.to_string()
    } else {
        trimmed.rsplit('\\').next().unwrap_or(trimmed).to_string()
    };
    let base = if trimmed.len() <= 2 {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    };
    Ok(Tree::build(raw, 0, base, root_name, "walk"))
}
