// du: `du <roots...> [--depth N]` — MFT scan, prints folder tree to depth N (>=0.5 GB),
// plus totals of well-known regenerable artifact folders under each root.
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;
use strata_engine::{
    mft,
    tree::{Metric, Tree},
    Progress,
};

fn gb(b: u64) -> f64 {
    b as f64 / (1u64 << 30) as f64
}
const ART: &[&str] = &[
    "intermediate",
    "deriveddatacache",
    "saved",
    "binaries",
    "node_modules",
    "target",
    ".git",
    "build",
    "library",
    "temp",
    "obj",
    ".vs",
    "staged",
    "packaged",
    "archived",
    ".venv",
    "__pycache__",
    "ddc",
    "zen",
];

fn walk(t: &Tree, id: u32, depth: usize, max: usize, min: u64) {
    if depth > max {
        return;
    }
    for c in t.sorted_children(id, Metric::Alloc) {
        let a = t.alloc[c as usize];
        if a < min || !t.is_dir(c) {
            continue;
        }
        println!("{:>8.1} GB {}{}", gb(a), "  ".repeat(depth), t.name(c));
        walk(t, c, depth + 1, max, min);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let depth: usize = args
        .iter()
        .position(|a| a == "--depth")
        .map(|i| args[i + 1].parse().unwrap())
        .unwrap_or(2);
    let roots: Vec<&String> = args.iter().filter(|a| a.contains(':')).collect();
    let mut trees: BTreeMap<char, Tree> = BTreeMap::new();
    for r in &roots {
        let l = r.chars().next().unwrap().to_ascii_uppercase();
        trees.entry(l).or_insert_with(|| {
            mft::scan_volume(l, &Progress::default(), &AtomicBool::new(false)).unwrap()
        });
        let t = &trees[&l];
        let Some(id) = t.find_relative(r[3..].trim_end_matches(std::path::MAIN_SEPARATOR)) else {
            println!("## {r}: not found");
            continue;
        };
        println!(
            "\n## {r}  {:.1} GB, {} files",
            gb(t.alloc[id as usize]),
            t.files[id as usize]
        );
        walk(t, id, 0, depth, 512 << 20);
        let mut art: BTreeMap<String, (u64, u32)> = BTreeMap::new();
        t.for_each_descendant(id, |c| {
            if t.is_dir(c) {
                let n = t.name(c).to_lowercase();
                if ART.contains(&n.as_str()) {
                    // count only outermost occurrence of the same name
                    let p = t.parent[c as usize];
                    if t.name(p).to_lowercase() != n {
                        let e = art.entry(n).or_default();
                        e.0 += t.alloc[c as usize];
                        e.1 += 1;
                    }
                }
            }
        });
        let mut v: Vec<_> = art
            .into_iter()
            .filter(|(_, (a, _))| *a > 256 << 20)
            .collect();
        v.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
        println!("  -- artifact-named folders (nested overlaps possible):");
        for (n, (a, k)) in v {
            println!("  {:>8.1} GB  {n} x{k}", gb(a));
        }
    }
}
