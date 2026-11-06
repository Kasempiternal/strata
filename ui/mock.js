/* Strata mock backend: implements every command and event in docs/API.md over a
   generated in-memory tree. Loaded only when window.__TAURI__ is undefined.
   Query flags: ?admin=1 (admin mode, MFT scans), ?slow=1 (slower scan). */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const state = {
    admin: params.get('admin') === '1',
    scanMs: params.get('slow') ? 5000 : 1600,
    bin: { items: 1243, size: 3.84 * 1024 ** 3 },
    drives: [
      { path: 'C:\\', label: 'Windows', fs: 'NTFS', total: 931.5 * 1024 ** 3, free: 212.4 * 1024 ** 3, removable: false },
      { path: 'D:\\', label: 'Games', fs: 'NTFS', total: 1862.9 * 1024 ** 3, free: 641.8 * 1024 ** 3, removable: false },
      { path: 'E:\\', label: 'USB Drive', fs: 'NTFS', total: 58.4 * 1024 ** 3, free: 41.1 * 1024 ** 3, removable: true },
    ],
  };

  const listeners = {};
  const emit = (name, payload) => (listeners[name] || []).slice().forEach((f) => f({ event: name, payload }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- tree storage (struct of arrays) ---------- */
  const CAP = 800000;
  let T = null;

  function newTree() {
    return {
      n: 0,
      parent: new Int32Array(CAP),
      isDir: new Uint8Array(CAP),
      removed: new Uint8Array(CAP),
      size: new Float64Array(CAP),
      alloc: new Float64Array(CAP),
      files: new Int32Array(CAP),
      dirs: new Int32Array(CAP),
      name: new Array(CAP),
      kids: new Array(CAP),
      cache: new Map(),
      sortedFiles: {},
    };
  }
  const allocOf = (s) => (s === 0 ? 0 : Math.ceil(s / 4096) * 4096);

  function addNode(p, name, isDir, size) {
    if (T.n >= CAP) return p;
    const id = T.n++;
    T.parent[id] = p;
    T.isDir[id] = isDir ? 1 : 0;
    T.name[id] = name;
    if (isDir) T.kids[id] = [];
    else { T.size[id] = size; T.alloc[id] = allocOf(size); }
    if (p >= 0) T.kids[p].push(id);
    return id;
  }

  function aggregate() {
    for (let i = T.n - 1; i > 0; i--) {
      const p = T.parent[i];
      T.size[p] += T.size[i];
      T.alloc[p] += T.alloc[i];
      if (T.isDir[i]) { T.files[p] += T.files[i]; T.dirs[p] += T.dirs[i] + 1; } else T.files[p] += 1;
    }
  }

  /* ---------- generator ---------- */
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const WORDS = 'config data index main utils core helper module base cache log report image backup setup driver update manifest schema runtime plugin theme locale icon font sound texture model shader level asset bundle chunk session profile history cookies journal metadata resource'.split(' ');
  const PKGS = 'react lodash typescript webpack core-js eslint rxjs moment date-fns axios express vite esbuild next tailwindcss postcss sass jest prettier playwright-core electron three d3 chalk debug glob minimatch semver yargs commander uuid zod ajv acorn terser rollup babel-loader css-loader style-loader tslib iconv-lite readable-stream inherits mime ms qs send serve-static'.split(' ');
  const SCOPES = ['@types', '@babel', '@swc', '@esbuild', '@jridgewell', '@rollup', '@eslint'];

  function generate(path, isRoot) {
    T = newTree();
    const R = rng(isRoot ? 1337 : 4242);
    const pick = (a) => a[Math.floor(R() * a.length)];
    const sz = (avg) => {
      const g = (R() + R() + R() - 1.5) * 2;
      return Math.max(1, Math.round(avg * Math.min(7, Math.exp(1.15 * g - 0.66))));
    };
    const D = (p, n) => addNode(p, n, true, 0);
    const FN = (p, n, s) => addNode(p, n, false, s);
    const F = (p, n, avg, exts) => {
      const list = exts.split(' ');
      for (let i = 0; i < n; i++) FN(p, pick(WORDS) + (i + 1) + '.' + pick(list), sz(avg));
    };
    const tree = (p, spec) => {
      for (const [k, v] of Object.entries(spec)) {
        if (k === '_f') for (const [n, avg, exts] of v) F(p, n, avg, exts);
        else if (k === '_s') for (const [n, s] of Object.entries(v)) FN(p, n, s);
        else tree(D(p, k), v);
      }
    };

    const nodeModules = (p, pkgs) => {
      const nm = D(p, 'node_modules');
      const scopeDirs = {};
      for (let i = 0; i < pkgs; i++) {
        let base = PKGS[i % PKGS.length] + (i < PKGS.length ? '' : '-' + Math.floor(i / PKGS.length));
        let parent = nm;
        if (R() < 0.18) {
          const sc = pick(SCOPES);
          parent = scopeDirs[sc] || (scopeDirs[sc] = D(nm, sc));
          base = base.replace(/-\d+$/, '') + '-' + i;
        }
        const d = D(parent, base);
        FN(d, 'package.json', sz(2200)); FN(d, 'README.md', sz(7000)); FN(d, 'LICENSE', 1100); FN(d, 'index.js', sz(9000));
        const big = R() < 0.12;
        const lib = D(d, 'lib');
        F(lib, 3 + Math.floor(R() * (big ? 70 : 18)), 7000, 'js js js js.map d.ts');
        if (R() < 0.5) F(D(d, 'dist'), 2 + Math.floor(R() * 5), big ? 700000 : 90000, 'js js.map min.js');
        if (R() < 0.3) F(D(d, 'types'), 2 + Math.floor(R() * 12), 3000, 'd.ts');
      }
    };

    const rust = (p, w) => {
      const t = D(p, 'target');
      const dbg = D(t, 'debug');
      F(D(dbg, 'deps'), Math.floor(w * 2200), 380000, 'rlib rmeta d o');
      F(D(dbg, 'build'), Math.floor(w * 700), 60000, 'rs o json');
      F(D(dbg, 'incremental'), Math.floor(w * 900), 900000, 'bin o');
      FN(dbg, 'strata.exe', 21 * 1024 ** 2); FN(dbg, 'strata.pdb', 38 * 1024 ** 2);
      F(D(D(t, 'release'), 'deps'), Math.floor(w * 700), 300000, 'rlib rmeta d');
    };

    const user = (p) => {
      const U = D(p, 'alex');
      const A = D(U, 'AppData');
      const L = D(A, 'Local');
      const chrome = D(D(D(D(L, 'Google'), 'Chrome'), 'User Data'), 'Default');
      F(D(D(chrome, 'Cache'), 'Cache_Data'), 5200, 34000, 'cache');
      F(D(chrome, 'Code Cache'), 2400, 22000, 'js cache');
      F(D(chrome, 'Service Worker'), 600, 60000, 'cache');
      FN(chrome, 'History', 41 * 1024 ** 2); FN(chrome, 'Favicons', 9 * 1024 ** 2);
      const temp = D(L, 'Temp');
      F(temp, 3800, 70000, 'tmp log etl dmp');
      FN(temp, 'nvidia-installer-576.80.zip', 931 * 1024 ** 2);
      FN(temp, 'MiniDump-0xA3F.dmp', 612 * 1024 ** 2);
      F(D(temp, 'chrome_BITS_9244'), 900, 120000, 'crdownload tmp');
      const msL = D(L, 'Microsoft');
      F(D(D(msL, 'Windows'), 'Explorer'), 60, 4 * 1024 ** 2, 'db');
      F(D(msL, 'Edge'), 3000, 41000, 'cache js');
      F(D(msL, 'OneDrive'), 800, 640000, 'dll exe dat');
      F(D(D(L, 'Packages'), 'Microsoft.WindowsStore_8wekyb3d8bbwe'), 1800, 90000, 'png dat db');
      F(D(D(L, 'Discord'), 'app-1.0.9187'), 900, 430000, 'dll pak node asar');
      const prog = D(L, 'Programs');
      F(D(prog, 'Microsoft VS Code'), 3900, 160000, 'js json dll pak node ts');
      F(D(prog, 'Python'), 5200, 52000, 'py pyc pyd dll');
      F(D(D(L, 'npm-cache'), '_cacache'), 21000, 26000, 'cache');
      F(D(D(L, 'pip'), 'cache'), 1500, 230000, 'whl');
      F(D(D(L, 'JetBrains'), 'RustRover2026.2'), 2400, 280000, 'jar idx cache');
      FN(D(D(D(L, 'Docker'), 'wsl'), 'data'), 'ext4.vhdx', 47.5 * 1024 ** 3);
      const Ro = D(A, 'Roaming');
      F(D(D(Ro, 'Code'), 'CachedExtensionVSIXs'), 40, 14 * 1024 ** 2, 'vsix');
      F(D(D(Ro, 'Code'), 'User'), 300, 90000, 'json vscdb log');
      F(D(D(Ro, 'discord'), 'Cache'), 1400, 70000, 'cache');
      F(D(D(Ro, 'Spotify'), 'Storage'), 1900, 2 * 1024 ** 2, 'file');
      F(D(Ro, 'OBS Studio'), 140, 400000, 'json log ini');

      const docs = D(U, 'Documents');
      tree(docs, {
        Work: { Contracts: { _f: [[60, 2.4e6, 'pdf docx']] }, Reports: { _f: [[140, 5e6, 'xlsx pptx pdf']] }, Archive: { _f: [[400, 1.1e6, 'pdf zip docx']] } },
        Taxes: { _f: [[90, 1.8e6, 'pdf jpg']] },
        'Obsidian Vault': { _f: [[2400, 9000, 'md png']] },
        _f: [[120, 800000, 'pdf docx txt']],
      });
      const dl = D(U, 'Downloads');
      for (const [n, s] of Object.entries({
        'Win11_25H2_English_x64.iso': 6.7 * 1024 ** 3, 'ubuntu-26.04-desktop-amd64.iso': 5.9 * 1024 ** 3,
        'BG3_Patch_9_Offline.zip': 3.4 * 1024 ** 3, 'Blender-5.1.0-windows-x64.msi': 412 * 1024 ** 2,
        'AdobeCreativeCloudSetup.exe': 1.1 * 1024 ** 3, 'dataset-v3.tar.gz': 8.2 * 1024 ** 3,
      })) FN(dl, n, s);
      F(dl, 160, 60 * 1024 ** 2, 'zip exe msi pdf 7z mp4');
      const vid = D(U, 'Videos');
      F(D(vid, 'OBS Recordings'), 38, 0.9 * 1024 ** 3, 'mkv mp4');
      F(D(vid, 'Captures'), 220, 180 * 1024 ** 2, 'mp4');
      F(D(vid, 'Edits'), 12, 1.4 * 1024 ** 3, 'mp4 mov');
      const pic = D(U, 'Pictures');
      F(D(pic, 'Camera Roll'), 5200, 3.6 * 1024 ** 2, 'jpg jpg jpg heic png');
      F(D(pic, 'Screenshots'), 1300, 900000, 'png');
      F(D(pic, 'RAW'), 480, 28 * 1024 ** 2, 'arw dng');
      F(D(U, 'Music'), 1700, 7.5 * 1024 ** 2, 'mp3 flac m4a');
      F(D(U, 'Desktop'), 40, 3 * 1024 ** 2, 'lnk png pdf txt');

      const repos = D(D(U, 'source'), 'repos');
      const strata = D(repos, 'strata');
      nodeModules(D(strata, 'ui'), 900);
      rust(strata, 1);
      F(D(strata, 'src'), 90, 12000, 'rs ts js css');
      nodeModules(D(D(repos, 'trading-dashboard'), 'web'), 650);
      F(D(D(repos, 'trading-dashboard'), 'research'), 110, 4e5, 'md csv parquet pdf');
      const ue = D(docs, 'Unreal Projects');
      F(D(D(ue, 'ArenaShooter'), 'Saved'), 220, 40e6, 'uasset umap log');
      F(D(D(ue, 'ArenaShooter'), 'DerivedDataCache'), 1400, 6e6, 'ddc');
      F(D(D(ue, 'ArenaShooter'), 'Content'), 900, 9e6, 'uasset umap');
      F(D(D(ue, 'ArenaShooter'), 'Intermediate'), 700, 3e6, 'obj pdb');
      const rb = D(repos, 'card-scanner');
      nodeModules(rb, 780);
      F(D(rb, '.next'), 1800, 70000, 'js map json');
      nodeModules(D(repos, 'web-portfolio'), 1250);
      F(D(D(repos, 'ml-experiments'), 'checkpoints'), 36, 0.7 * 1024 ** 3, 'pt safetensors');
      F(D(D(repos, 'ml-experiments'), 'data'), 7200, 380000, 'npy jpg csv');

      F(D(D(U, '.cargo'), 'registry'), 17000, 14000, 'rs toml crate');
      F(D(D(U, '.rustup'), 'toolchains'), 14500, 160000, 'rlib dll exe html');
      F(D(D(U, '.nuget'), 'packages'), 9000, 52000, 'dll xml nupkg');
      F(D(D(U, '.vscode'), 'extensions'), 8300, 28000, 'js json map');
      F(D(D(U, '.docker'), 'buildx'), 300, 90000, 'json');
      F(D(U, '.gradle'), 3400, 300000, 'jar bin');
      F(U, 20, 30000, 'json log');
      FN(U, 'NTUSER.DAT', 118 * 1024 ** 2);
    };

    if (!isRoot) {
      const root = addNode(-1, path, true, 0);
      user(D(root, 'Users'));
      aggregate();
      return root;
    }

    const root = addNode(-1, path, true, 0);
    FN(root, 'pagefile.sys', 12 * 1024 ** 3);
    FN(root, 'hiberfil.sys', 6.4 * 1024 ** 3);
    FN(root, 'swapfile.sys', 16 * 1024 ** 2);
    F(D(root, 'Recovery'), 3, 380 * 1024 ** 2, 'wim');
    F(D(root, 'Temp'), 700, 45000, 'tmp log');

    const win = D(root, 'Windows');
    F(D(win, 'System32'), 3600, 410000, 'dll dll dll exe sys mui');
    F(D(D(D(win, 'System32'), 'drivers'), 'UMDF'), 220, 120000, 'dll');
    F(D(D(win, 'System32'), 'DriverStore'), 40, 30000, 'dat');
    F(D(D(D(win, 'System32'), 'DriverStore'), 'FileRepository'), 5800, 360000, 'dll sys inf cat bin');
    F(D(win, 'SysWOW64'), 3100, 300000, 'dll exe');
    const sxs = D(win, 'WinSxS');
    for (let i = 0; i < 520; i++) {
      const d = D(sxs, `${pick(['amd64', 'x86', 'wow64'])}_microsoft-windows-${pick(WORDS)}-${i}_31bf3856ad364e35_10.0.26100.${1000 + i * 7}_none_${Math.floor(R() * 1e15).toString(16)}`);
      F(d, 35 + Math.floor(R() * 90), 190000, 'dll mui manifest cat');
    }
    F(D(win, 'Installer'), 340, 38 * 1024 ** 2, 'msi msp');
    F(D(win, 'Fonts'), 520, 650000, 'ttf otf ttc');
    F(D(D(win, 'SoftwareDistribution'), 'Download'), 260, 18 * 1024 ** 2, 'cab psf msu');
    F(D(win, 'Logs'), 460, 900000, 'log etl cab');
    F(D(win, 'Temp'), 520, 120000, 'tmp log');
    F(D(D(win, 'Microsoft.NET'), 'Framework64'), 1900, 280000, 'dll exe xml');
    F(D(D(win, 'assembly'), 'GAC_MSIL'), 2400, 180000, 'dll');
    F(D(win, 'Prefetch'), 420, 70000, 'pf');
    F(D(win, 'servicing'), 800, 1.6 * 1024 ** 2, 'mum cat manifest');
    F(D(win, 'Boot'), 160, 90000, 'efi dll mui');

    const pf = D(root, 'Program Files');
    const pf86 = D(root, 'Program Files (x86)');
    F(D(D(pf, 'Google'), 'Chrome'), 260, 5.2 * 1024 ** 2, 'dll pak exe bin');
    F(D(pf, 'NVIDIA Corporation'), 640, 4.4 * 1024 ** 2, 'dll exe bin json');
    F(D(D(pf, 'Microsoft Office'), 'root'), 3200, 640000, 'dll xml exe mui');
    F(D(pf, 'Adobe Photoshop 2026'), 4800, 780000, 'dll exe pat png');
    F(D(pf, 'Blender Foundation'), 3600, 1.4 * 1024 ** 2, 'py pyc dll blend');
    F(D(pf, 'Docker'), 380, 18 * 1024 ** 2, 'exe dll');
    F(D(pf, 'Common Files'), 900, 280000, 'dll');
    F(D(pf86, 'Microsoft'), 1800, 380000, 'dll exe');
    const games = D(D(pf86, 'Steam'), 'steamapps');
    const common = D(games, 'common');
    F(D(common, 'Baldurs Gate 3'), 84, 0.45 * 1024 ** 3, 'pak dll exe');
    F(D(common, 'Cyberpunk 2077'), 120, 190 * 1024 ** 2, 'archive dll exe');
    F(D(common, 'Counter-Strike Global Offensive'), 230, 60 * 1024 ** 2, 'vpk dll bsp');
    F(D(common, 'Elden Ring'), 160, 90 * 1024 ** 2, 'bdt dll exe');
    F(D(common, 'Hades II'), 300, 38 * 1024 ** 2, 'pkg dll lua');
    F(D(games, 'shadercache'), 4800, 480000, 'bin');
    F(D(games, 'workshop'), 900, 12 * 1024 ** 2, 'bin vpk');

    const pd = D(root, 'ProgramData');
    F(D(D(D(pd, 'Microsoft'), 'Windows Defender'), 'Scans'), 2100, 60000, 'dat db');
    F(D(D(pd, 'NVIDIA'), 'Downloader'), 60, 9 * 1024 ** 2, 'exe');
    F(D(pd, 'Package Cache'), 880, 7 * 1024 ** 2, 'msi exe cab');
    F(D(pd, 'Microsoft'), 2400, 150000, 'dat log xml');

    const users = D(root, 'Users');
    user(users);
    F(D(users, 'Public'), 60, 1.3e6, 'png jpg ini');
    aggregate();
    return root;
  }

  /* ---------- queries ---------- */
  const val = (id, metric) => (metric === 'size' ? T.size[id] : T.alloc[id]);
  const info = (id) => ({
    id, name: T.name[id], isDir: !!T.isDir[id], size: T.size[id], alloc: T.alloc[id],
    files: T.isDir[id] ? T.files[id] : 0, dirs: T.isDir[id] ? T.dirs[id] : 0,
  });
  function nodePath(id) {
    const parts = [];
    for (let i = id; i >= 0; i = T.parent[i]) parts.push(T.name[i]);
    parts.reverse();
    let out = parts[0];
    for (let i = 1; i < parts.length; i++) out += (out.endsWith('\\') ? '' : '\\') + parts[i];
    return out;
  }
  function checkId(id) {
    if (!T || id == null || id < 0 || id >= T.n || T.removed[id]) throw new Error('Unknown node ' + id);
  }
  function sortedKids(id, how, metric) {
    const key = id + '|' + how + '|' + metric;
    let a = T.cache.get(key);
    if (a) return a;
    a = T.kids[id].slice();
    if (how === 'name') a.sort((x, y) => T.name[x].localeCompare(T.name[y], undefined, { numeric: true }));
    else if (how === 'files') a.sort((x, y) => T.files[y] - T.files[x] || val(y, metric) - val(x, metric));
    else a.sort((x, y) => val(y, metric) - val(x, metric));
    T.cache.set(key, a);
    return a;
  }

  function listChildren({ id, metric = 'alloc', sort = 'metric', limit = 2000 }) {
    checkId(id);
    const node = info(id);
    const ks = T.isDir[id] ? sortedKids(id, sort, metric) : [];
    const children = ks.slice(0, limit).map(info);
    let moreValue = 0;
    for (let i = limit; i < ks.length; i++) moreValue += val(ks[i], metric);
    const crumbs = [];
    for (let i = id; i >= 0; i = T.parent[i]) crumbs.push({ id: i, name: T.name[i] });
    crumbs.reverse();
    return { node, path: nodePath(id), crumbs, children, more: Math.max(0, ks.length - limit), moreValue };
  }

  function sunburst({ id, metric = 'alloc', depth = 4, minFraction = 0.004 }) {
    checkId(id);
    const total = val(id, metric) || 1;
    const rec = (nid, d) => {
      const o = { id: nid, name: T.name[nid], v: val(nid, metric), isDir: !!T.isDir[nid] };
      if (T.isDir[nid] && d < depth) {
        const ks = sortedKids(nid, 'metric', metric);
        const ch = [];
        let shown = 0;
        let i = 0;
        for (; i < ks.length; i++) {
          const v = val(ks[i], metric);
          if (v <= 0 || v / total < minFraction) break;
          ch.push(rec(ks[i], d + 1));
          shown += v;
        }
        let rest = 0;
        for (let j = i; j < ks.length && j < i + 5; j++) if (val(ks[j], metric) > 0) rest++;
        const restN = ks.length - i;
        if (restN > 0 && rest > 0) {
          if (restN === 1) ch.push(rec(ks[i], d + 1));
          else ch.push({ id: -1, name: restN.toLocaleString('en-US') + ' smaller items', v: o.v - shown, isDir: false });
        }
        if (ch.length) o.children = ch;
      }
      return o;
    };
    return rec(id, 0);
  }

  function inSubtree(id, root) {
    for (let i = id; i >= 0; i = T.parent[i]) {
      if (T.removed[i]) return false;
      if (i === root) return true;
    }
    return false;
  }
  function largestFiles({ id, metric = 'alloc', limit = 500 }) {
    checkId(id);
    let all = T.sortedFiles[metric];
    if (!all) {
      all = [];
      for (let i = 1; i < T.n; i++) if (!T.isDir[i] && !T.removed[i]) all.push(i);
      all.sort((a, b) => val(b, metric) - val(a, metric));
      T.sortedFiles[metric] = all;
    }
    const out = [];
    for (let i = 0; i < all.length && out.length < limit; i++) {
      if (inSubtree(all[i], id)) out.push({ ...info(all[i]), path: nodePath(all[i]) });
    }
    return out;
  }

  function fileTypes({ id, metric = 'alloc', limit = 60 }) {
    checkId(id);
    const m = new Map();
    const stack = [id];
    while (stack.length) {
      const n = stack.pop();
      if (T.isDir[n]) { for (const k of T.kids[n]) stack.push(k); continue; }
      const nm = T.name[n];
      const dot = nm.lastIndexOf('.');
      const ext = dot > 0 ? nm.slice(dot + 1).toLowerCase() : '';
      let e = m.get(ext);
      if (!e) m.set(ext, (e = { ext, count: 0, size: 0, alloc: 0 }));
      e.count++; e.size += T.size[n]; e.alloc += T.alloc[n];
    }
    const k = metric === 'size' ? 'size' : 'alloc';
    return [...m.values()].sort((a, b) => b[k] - a[k]).slice(0, limit);
  }

  const PROTECTED = new Set(['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users', 'alex']);
  function deleteItems({ ids, permanent }) {
    const deleted = [];
    const failed = [];
    let freed = 0;
    for (const id of ids) {
      try { checkId(id); } catch { failed.push({ id, path: '?', error: 'Item no longer exists' }); continue; }
      const path = nodePath(id);
      const p = T.parent[id];
      if (p < 0 || (PROTECTED.has(T.name[id]) && T.parent[p] <= 0) || T.name[id].startsWith('$')) {
        failed.push({ id, path, error: 'Protected system location cannot be deleted' });
        continue;
      }
      if (T.name[id] === 'NTUSER.DAT') { failed.push({ id, path, error: 'The process cannot access the file because it is being used by another process. (os error 32)' }); continue; }
      const dFiles = T.isDir[id] ? T.files[id] : 1;
      const dDirs = T.isDir[id] ? T.dirs[id] + 1 : 0;
      for (let a = p; a >= 0; a = T.parent[a]) {
        T.size[a] -= T.size[id]; T.alloc[a] -= T.alloc[id]; T.files[a] -= dFiles; T.dirs[a] -= dDirs;
      }
      const sibs = T.kids[p];
      sibs.splice(sibs.indexOf(id), 1);
      const stack = [id];
      while (stack.length) { const n = stack.pop(); T.removed[n] = 1; if (T.isDir[n]) for (const k of T.kids[n]) stack.push(k); }
      freed += T.alloc[id];
      if (!permanent) { state.bin.items += dFiles + dDirs; state.bin.size += T.alloc[id]; }
      else state.drives[0].free += T.alloc[id];
      deleted.push(id);
    }
    T.cache.clear();
    T.sortedFiles = {};
    return { deleted, failed, freed };
  }

  /* ---------- scan simulation ---------- */
  let scanTimer = null;
  function startScan({ path }) {
    if (scanTimer) throw new Error('A scan is already running');
    const isRoot = /^[A-Za-z]:\\?$/.test(path);
    const mode = isRoot && state.admin ? 'mft' : 'walk';
    const t0 = performance.now();
    const total = state.scanMs;
    let rootId = -1;
    let est = 0;
    setTimeout(() => {
      rootId = generate(path.endsWith('\\') && !isRoot ? path.slice(0, -1) : path, isRoot);
      est = T.files[rootId];
      tick();
    }, 30);
    const tick = () => {
      const el = performance.now() - t0;
      const f = Math.min(1, el / total);
      const ease = 1 - Math.pow(1 - f, 2);
      const buildFrom = 0.8;
      const phase = mode === 'mft' ? (f < buildFrom ? 'mft' : 'build') : f < buildFrom ? 'walk' : 'build';
      const prog = Math.min(1, ease / 1);
      emit('scan-progress', {
        phase,
        done: Math.floor(est * prog),
        total: phase === 'walk' ? 0 : est,
        files: Math.floor(est * prog),
        bytes: Math.floor(T.size[rootId] * prog),
        elapsedMs: Math.round(el),
      });
      if (f >= 1) {
        scanTimer = null;
        emit('scan-done', {
          rootId, path, mode, elapsedMs: Math.round(el), files: T.files[rootId], dirs: T.dirs[rootId],
          size: T.size[rootId], alloc: T.alloc[rootId],
        });
        return;
      }
      scanTimer = setTimeout(tick, 60);
    };
    scanTimer = 1;
    return null;
  }
  function cancelScan() {
    if (scanTimer && scanTimer !== 1) clearTimeout(scanTimer);
    if (scanTimer) { scanTimer = null; emit('scan-cancelled', {}); }
    return null;
  }

  /* ---------- command table ---------- */
  const noop = () => null;
  const commands = {
    app_status: () => ({ admin: state.admin, version: '1.0.0' }),
    relaunch_admin: () => { setTimeout(() => { location.search = '?admin=1'; }, 400); return new Promise(() => {}); },
    list_drives: () => state.drives.map((d) => ({ ...d })),
    pick_folder: async () => { await sleep(250); return 'C:\\Users\\alex\\source\\repos'; },
    start_scan: startScan,
    cancel_scan: cancelScan,
    list_children: listChildren,
    sunburst,
    largest_files: largestFiles,
    file_types: fileTypes,
    node_path: ({ id }) => { checkId(id); return nodePath(id); },
    delete_items: deleteItems,
    reveal: ({ id }) => { checkId(id); console.info('[mock] reveal', nodePath(id)); return null; },
    open_item: ({ id }) => { checkId(id); console.info('[mock] open', nodePath(id)); return null; },
    recycle_bin: () => ({ ...state.bin }),
    empty_recycle_bin: () => { state.drives[0].free += state.bin.size; state.bin = { items: 0, size: 0 }; return null; },
  };

  let maximized = false;
  window.__MOCK__ = true;
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        const fn = commands[cmd];
        if (!fn) throw new Error('Unknown command: ' + cmd);
        await sleep(cmd === 'sunburst' || cmd === 'file_types' || cmd === 'largest_files' ? 25 : 8);
        return fn(args);
      },
    },
    event: {
      listen: async (name, cb) => {
        (listeners[name] = listeners[name] || []).push(cb);
        return () => { listeners[name] = listeners[name].filter((f) => f !== cb); };
      },
    },
    window: {
      getCurrentWindow: () => ({
        minimize: noop, close: noop,
        toggleMaximize: async () => { maximized = !maximized; },
        isMaximized: async () => maximized,
        onResized: async () => () => {},
      }),
    },
  };
})();
