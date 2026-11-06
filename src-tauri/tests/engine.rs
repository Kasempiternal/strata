//! Engine integration tests (no admin required).
use std::fs;
use std::sync::atomic::AtomicBool;
use strata_engine::tree::{Metric, RawNodes, Tree, F_DIR, NONE};
use strata_engine::{walk, winutil, Progress};

/// root(0) -> a(1, dir) -> [x.mp4(3, 100), y.MP4(4, 50)], b.txt(2, 10)
fn sample() -> Tree {
    let names = ["", "a", "b.txt", "x.mp4", "y.MP4"];
    let mut raw = RawNodes::with_capacity(5, 32);
    for (i, n) in names.iter().enumerate() {
        raw.name_off.push(raw.names.len() as u32);
        raw.names.push_str(n);
        raw.name_len.push(n.len() as u16);
        raw.parent.push([NONE, 0, 0, 1, 1][i]);
        let s = [0u64, 0, 10, 100, 50][i];
        raw.size.push(s);
        raw.alloc.push(s.div_ceil(8) * 8);
        raw.flags.push(if i <= 1 { F_DIR } else { 0 });
    }
    Tree::build(raw, 0, r"X:\".into(), "X:".into(), "test")
}

#[test]
fn totals_paths_and_queries() {
    let t = sample();
    assert_eq!(t.size[0], 160);
    assert_eq!((t.files[0], t.dirs[0]), (3, 1));
    assert_eq!(t.path(3), r"X:\a\x.mp4");
    assert_eq!(t.path(0), r"X:\");
    assert_eq!(t.find_relative(r"A\X.MP4"), Some(3));
    assert_eq!(t.sorted_children(0, Metric::Size), vec![1, 2]);
    assert_eq!(t.largest_files(0, Metric::Size, 2), vec![3, 4]);
    let types = t.file_types(0);
    let mp4 = types.iter().find(|e| e.0 == "mp4").unwrap();
    assert_eq!((mp4.1, mp4.2), (2, 150), "extensions are case-insensitive");
    assert_eq!(t.crumbs(3), vec![0, 1, 3]);
}

#[test]
fn remove_updates_every_ancestor() {
    let mut t = sample();
    t.remove(3);
    assert_eq!(t.size[1], 50);
    assert_eq!(t.size[0], 60);
    assert_eq!(t.files[0], 2);
    assert!(!t.children(1).any(|c| c == 3));
    t.remove(1);
    assert_eq!((t.size[0], t.files[0], t.dirs[0]), (10, 1, 0));
    assert!(t.is_deleted_or_under_deleted(4));
}

#[test]
fn walk_scans_a_real_folder() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("sub/deeper")).unwrap();
    fs::write(dir.path().join("one.bin"), vec![1u8; 5000]).unwrap();
    fs::write(dir.path().join("sub/deeper/two.bin"), vec![2u8; 70_000]).unwrap();
    let t = walk::scan_path(
        dir.path().to_str().unwrap(),
        &Progress::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let r = t.root as usize;
    assert_eq!(t.size[r], 75_000);
    assert_eq!((t.files[r], t.dirs[r]), (2, 2));
    assert!(
        t.alloc[r] >= t.size[r],
        "size on disk rounds up to clusters"
    );
    let two = t.find_relative(r"sub\deeper\two.bin").unwrap();
    assert_eq!(
        t.path(two),
        dir.path().join(r"sub\deeper\two.bin").to_str().unwrap()
    );
}

#[test]
fn walk_honours_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let r = walk::scan_path(
        dir.path().to_str().unwrap(),
        &Progress::default(),
        &AtomicBool::new(true),
    );
    assert!(r.is_err());
}

#[test]
fn protected_paths() {
    let profile = std::env::var("USERPROFILE").unwrap();
    for p in [
        r"C:\",
        r"C:",
        r"C:\Windows",
        r"C:\Windows\System32\drivers",
        r"C:\Program Files",
        r"C:\Users",
        r"C:\$MFT",
        r"C:\pagefile.sys",
        r"C:\System Volume Information",
        profile.as_str(),
    ] {
        assert!(winutil::is_protected(p), "{p} must be protected");
    }
    for p in [
        r"C:\Users\someone\Downloads\big.iso",
        r"C:\Program Files (x86)\Steam\steamapps\common\SomeGame",
        r"D:\Photos",
        &format!(r"{profile}\Downloads"),
    ] {
        assert!(!winutil::is_protected(p), "{p} must be deletable");
    }
}

/// Moves a temp file to the Recycle Bin. Ignored by default (touches the real bin);
/// run with `cargo test -- --ignored`.
#[test]
#[ignore]
fn recycle_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("strata-recycle-test.bin");
    fs::write(&f, b"x").unwrap();
    trash::delete(&f).unwrap();
    assert!(!f.exists());
}
