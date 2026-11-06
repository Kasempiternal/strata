//! Headless scan benchmark: `cargo run --release --example bench -- C:\ [walk]`
use std::sync::atomic::AtomicBool;
use std::time::Instant;
use strata_engine::tree::Metric;
use strata_engine::{mft, walk, Progress};

fn gb(b: u64) -> String {
    format!("{:.2} GB", b as f64 / (1u64 << 30) as f64)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).cloned().unwrap_or_else(|| "C:\\".into());
    let force_walk = args.iter().any(|a| a == "walk");
    let prog = Progress::default();
    let cancel = AtomicBool::new(false);
    let t0 = Instant::now();
    let tree = if force_walk {
        walk::scan_path(&path, &prog, &cancel)
    } else {
        mft::scan_volume(
            path.chars().next().unwrap().to_ascii_uppercase(),
            &prog,
            &cancel,
        )
    }
    .expect("scan failed");
    let el = t0.elapsed();
    let r = tree.root as usize;
    println!(
        "mode={} time={:.2?} nodes={} files={} dirs={} size={} alloc={}",
        tree.mode,
        el,
        tree.parent.len(),
        tree.files[r],
        tree.dirs[r],
        gb(tree.size[r]),
        gb(tree.alloc[r])
    );
    let t1 = Instant::now();
    let top = tree.sorted_children(tree.root, Metric::Alloc);
    for &c in top.iter().take(12) {
        println!("  {:>10}  {}", gb(tree.alloc[c as usize]), tree.name(c));
    }
    let lf = tree.largest_files(tree.root, Metric::Alloc, 5);
    for c in lf {
        println!(
            "  file {:>10}  {}",
            gb(tree.alloc[c as usize]),
            tree.path(c)
        );
    }
    let ft = tree.file_types(tree.root);
    println!("queries {:.2?}  ({} extensions)", t1.elapsed(), ft.len());
}
