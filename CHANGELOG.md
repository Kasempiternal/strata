# Changelog

All notable changes to Strata are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-06

First public release.

### Added
- **MFT scanning (administrator):** reads the NTFS Master File Table straight off the volume with parallel,
  unbuffered 16 MiB reads, and skips unused records using `$MFT:$BITMAP`. A 1.8 TB drive with 3.5 M files scans in about 3 s on NVMe.
- **Folder-walk fallback:** a parallel `FindFirstFileExW` walk for standard (non-admin) mode, non-NTFS
  volumes and network paths. Cloud placeholders (OneDrive) count as 0 bytes on disk.
- **Explore view:** an interactive sunburst (4 rings, animated drill-in and out) linked to a virtualised, sortable list,
  with breadcrumbs, back/up navigation and keyboard shortcuts.
- **Largest files** and **File types** views for any folder.
- **Size on disk / Logical size** toggle. Size on disk accounts for compression, sparse files, alternate data streams and resident files.
- **Safe delete:** Recycle Bin by default, with an explicit permanent-delete option. Every delete asks for confirmation, and protected locations
  (Windows, Program Files roots, the user profile root, drive roots, NTFS metadata, page and hibernation files) are refused.
- Recycle Bin size and **Empty Recycle Bin** in the sidebar.
- **Restart as administrator** from inside the app.
- Headless engine tools: `bench`, `du`, `finddirs` (see `src-tauri/examples`).

[1.0.0]: https://github.com/Kasempiternal/strata/releases/tag/v1.0.0
