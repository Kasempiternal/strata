# Contributing to Strata

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Setup

Requirements: Windows 10/11 x64, [Rust](https://rustup.rs) (stable, MSVC), Node.js 20+, the Visual Studio C++ Build Tools,
and WebView2 (preinstalled on Windows 11).

```powershell
git clone https://github.com/Kasempiternal/strata
cd strata
npm install
npx tauri dev          # run the app with hot reload of the UI
npx tauri build        # release build + installer in src-tauri/target/release/bundle/nsis
```

To use MFT mode during development, run your terminal **as administrator**. Otherwise Strata uses the folder walk.

## Project layout

| Path | What |
|---|---|
| `src-tauri/src/mft.rs` | Raw NTFS Master File Table reader (the fast path) |
| `src-tauri/src/walk.rs` | Parallel directory walker (fallback) |
| `src-tauri/src/tree.rs` | Flat struct-of-arrays file tree plus queries |
| `src-tauri/src/winutil.rs` | Win32 helpers: drives, elevation, shell, Recycle Bin, protected paths |
| `src-tauri/src/main.rs` | Tauri commands and events (contract in [`docs/API.md`](docs/API.md)) |
| `ui/` | The UI: plain HTML/CSS/JS, no bundler |
| `ui/mock.js` | A fake backend, so the UI runs in a normal browser (`npx serve ui`) |
| `site/` | Landing page, deployed to GitHub Pages |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the engine works.

## Before opening a PR

```powershell
cd src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test --lib --tests
```

- Keep the scan hot path free of per-file allocations and locks. If you touch `mft.rs` or `walk.rs`,
  include before/after numbers from `cargo run --release --example bench -- C:\` in the PR (run it elevated).
- UI changes: attach a screenshot or GIF.
- Anything that deletes files must keep going through `winutil::is_protected` and a confirmation dialog.

## Releasing (maintainers)

1. Bump the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`.
2. Add a `## [x.y.z]` section to `CHANGELOG.md`.
3. Commit, then `git tag vx.y.z && git push --tags`. The Release workflow builds the installer and publishes it.
