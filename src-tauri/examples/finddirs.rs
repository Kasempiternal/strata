// finddirs <name,name,...> <roots...>: lists every directory whose name matches (case-insensitive),
// outermost match only, with size on disk, newest-first not needed; sorted by size.
use std::sync::atomic::AtomicBool;
use strata_engine::{mft, tree::Tree, Progress};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let names: Vec<String> = args[0].split(',').map(|s| s.to_lowercase()).collect();
    let mut trees: Vec<(char, Tree)> = Vec::new();
    let mut hits: Vec<(u64, String)> = Vec::new();
    for r in &args[1..] {
        let l = r.chars().next().unwrap().to_ascii_uppercase();
        if !trees.iter().any(|(c, _)| *c == l) {
            trees.push((
                l,
                mft::scan_volume(l, &Progress::default(), &AtomicBool::new(false)).unwrap(),
            ));
        }
        let t = &trees.iter().find(|(c, _)| *c == l).unwrap().1;
        let rel = r[3..].trim_end_matches(std::path::MAIN_SEPARATOR);
        let Some(id) = t.find_relative(rel) else {
            eprintln!("not found: {r}");
            continue;
        };
        let mut stack = vec![id];
        while let Some(v) = stack.pop() {
            for c in t.children(v) {
                if !t.is_dir(c) {
                    continue;
                }
                if names.contains(&t.name(c).to_lowercase()) {
                    hits.push((t.alloc[c as usize], t.path(c)));
                } else {
                    stack.push(c);
                }
            }
        }
    }
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    let total: u64 = hits.iter().map(|h| h.0).sum();
    for (a, p) in &hits {
        if *a >= 64 << 20 {
            println!("{:>8.2} GB  {}", *a as f64 / (1u64 << 30) as f64, p);
        }
    }
    println!(
        "TOTAL {:.1} GB in {} dirs",
        total as f64 / (1u64 << 30) as f64,
        hits.len()
    );
}
