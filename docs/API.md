# Strata — backend ⇄ UI contract

Frontend is plain HTML/CSS/JS in `ui/` (no bundler). Tauri globals are enabled:

```js
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow(); // minimize(), toggleMaximize(), close(), isMaximized()
```

All sizes are bytes (JS numbers). `metric` is `"alloc"` (size on disk, default) or `"size"` (logical size).
Node ids are integers, valid until the next scan starts.

## Types

```ts
Drive    = { path: "C:\\", label: string, fs: "NTFS", total: number, free: number, removable: boolean }
NodeInfo = { id: number, name: string, isDir: boolean, size: number, alloc: number,
             files: number, dirs: number }           // files/dirs = recursive counts (0 for files)
Crumb    = { id: number, name: string }
Burst    = { id: number, name: string, v: number, isDir: boolean, children?: Burst[] }
           // id === -1 means an aggregated "N smaller items" slice (not clickable)
```

## Commands (`await invoke(name, args)`)

| command | args | returns |
|---|---|---|
| `app_status` | – | `{ admin: boolean, version: string }` |
| `relaunch_admin` | – | never returns (app restarts elevated via UAC) |
| `list_drives` | – | `Drive[]` |
| `pick_folder` | – | `string \| null` (native folder dialog) |
| `start_scan` | `{ path }` | `null` immediately; progress comes through events |
| `cancel_scan` | – | `null` |
| `list_children` | `{ id, metric, sort, limit }` sort: `"metric"\|"name"\|"files"` | `{ node: NodeInfo, path: string, crumbs: Crumb[], children: NodeInfo[], more: number, moreValue: number }` (crumbs root→node inclusive; `more` = children not returned) |
| `sunburst` | `{ id, metric, depth, minFraction }` (e.g. depth 4, minFraction 0.004) | `Burst` rooted at `id` |
| `largest_files` | `{ id, metric, limit }` | `(NodeInfo & { path: string })[]` sorted desc |
| `file_types` | `{ id, metric, limit }` | `{ ext: string, count: number, size: number, alloc: number }[]` sorted desc by metric (`ext` "" = no extension) |
| `node_path` | `{ id }` | `string` |
| `delete_items` | `{ ids: number[], permanent: boolean }` | `{ deleted: number[], failed: {id, path, error}[], freed: number }` — tree is updated in place (ancestor totals shrink) |
| `reveal` | `{ id }` | `null` (Explorer opens with the item selected) |
| `open_item` | `{ id }` | `null` (shell open) |
| `recycle_bin` | – | `{ items: number, size: number }` |
| `empty_recycle_bin` | – | `null` |

Protected paths (drive root, `C:\Windows`, `Program Files*`, `ProgramData` root, the user profile root, NTFS `$` metadata) are refused by `delete_items` and reported in `failed`.

## Events (`listen(name, e => e.payload)`)

| event | payload |
|---|---|
| `scan-progress` | `{ phase: "mft"\|"walk"\|"build", done: number, total: number, files: number, bytes: number, elapsedMs: number }` (`total` 0 = unknown; emitted ~every 60 ms) |
| `scan-done` | `{ rootId: number, path: string, mode: "mft"\|"walk", elapsedMs: number, files: number, dirs: number, size: number, alloc: number }` |
| `scan-error` | `{ message: string }` |
| `scan-cancelled` | `{}` |

`mode: "mft"` = raw NTFS Master File Table read (admin only, whole-volume, seconds). `"walk"` = parallel directory walk (fallback when not admin / non-NTFS / scanning a sub-folder).
