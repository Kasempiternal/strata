# How Strata works

Strata is a [Tauri 2](https://tauri.app) app: a Rust engine plus a plain HTML/CSS/JS UI rendered by WebView2.
The UI talks to the engine through the commands and events listed in [`API.md`](API.md).

```
 ┌──────────── UI (ui/) ────────────┐        ┌─────────────── Rust engine (src-tauri/src) ───────────────┐
 │ sunburst canvas · virtual list   │ invoke │ main.rs   commands, scan thread, progress ticker (60 ms)  │
 │ largest files · file types       │ ─────► │ mft.rs    raw NTFS $MFT reader        ┐                   │
 │ delete flow · drive sidebar      │ ◄───── │ walk.rs   parallel directory walker   ├─► tree.rs (SoA)   │
 └──────────────────────────────────┘ events │ winutil   drives · UAC · shell · Recycle Bin · guards     │
                                             └───────────────────────────────────────────────────────────┘
```

## The fast path: reading the Master File Table

Every file and folder on an NTFS volume is a 1 KiB record in a hidden system file, `$MFT`. Reading the MFT
directly avoids the millions of directory-listing calls that a normal scanner makes.

1. **Boot sector** (`\\.\C:` opened for reading; needs administrator rights): gives the cluster size, MFT location and record size.
2. **Map `$MFT` itself:** decode the data runs of record 0, following `$ATTRIBUTE_LIST` if the MFT is fragmented,
   into a list of `(stream offset → disk offset)` extents. Also read `$MFT:$BITMAP` to know which records are in use.
3. **Parallel read and parse:** split the MFT into 16 MiB jobs on a rayon pool. Each worker thread has its **own long-lived
   volume handle**, because the first read on a fresh volume handle is expensive (reopening per job made scans about 20× slower).
   Reads are unbuffered and sector-aligned (`FILE_FLAG_NO_BUFFERING`), so they don't push other data out of the OS file cache.
   Spans of unused records are skipped.
4. **Per record:** apply the update-sequence fixups (rejects torn records), then walk the attributes:
   - `$FILE_NAME`: the parent reference and the name. A Win32/POSIX name is preferred over the DOS 8.3 alias.
   - `$DATA`: logical size, and size on disk. Size on disk uses the compressed/sparse allocated size when present. Alternate data streams add to size on disk.
   - `$INDEX_ALLOCATION`: the space a large directory's index takes on disk.
   - Extension records (files with very many attributes) are folded back into their base record.
   - `$BadClus` is skipped, because its `$Bad` stream spans the whole volume.
5. **Build the tree** (`tree.rs`).

On a 2 TB NVMe drive with 5.6 M records (3.5 M files), steps 3–4 run at about 1.9 GB/s, close to the drive's measured
2.6–2.9 GB/s ceiling for this access pattern. The tree build takes about 0.4 s.

## The fallback: parallel walk

Without admin rights, on non-NTFS volumes or for network paths, `walk.rs` turns every directory into a rayon task:
`FindFirstFileExW(FindExInfoBasic, FIND_FIRST_EX_LARGE_FETCH)` returns names, sizes and attributes without opening files.
Node IDs are claimed in blocks with one atomic `fetch_add` per directory, so workers never contend per file.
Reparse points (junctions, symlinks) are not followed. Cloud placeholders (OneDrive) count as 0 bytes on disk.

## The tree

`Tree` is a struct of arrays: `parent`, name offset/length into a single UTF-8 arena, `size`, `alloc`,
recursive `files`/`dirs`, `flags`, and CSR child lists (`cstart`/`clist`) built with a counting sort. Totals are
accumulated in a single reverse-BFS pass. That costs about 45 bytes per node, plus names, with no per-node heap allocation.
Queries (children, sunburst, largest files, file types, paths) run directly on these arrays. Deleting marks a node
and subtracts its totals from every ancestor, so the UI updates instantly without a rescan.

## Deleting

`delete_items` works out the paths under a read lock, does the filesystem work (Recycle Bin through `IFileOperation`
via the `trash` crate, or `remove_dir_all`) **without holding any lock**, then updates the tree. If a new scan started
in the meantime, the generation check skips the update. `winutil::is_protected` is enforced in the backend, independent of the UI.
