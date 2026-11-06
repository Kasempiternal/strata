//! Flat, cache-friendly file tree (struct-of-arrays + CSR child lists).
//! Millions of nodes cost ~40 bytes each plus their UTF-8 names.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

pub const NONE: u32 = u32::MAX;
pub const F_DIR: u8 = 1;
pub const F_DELETED: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    Alloc,
    Size,
}

impl Metric {
    pub fn parse(s: &str) -> Metric {
        if s.eq_ignore_ascii_case("size") {
            Metric::Size
        } else {
            Metric::Alloc
        }
    }
}

/// Raw node data produced by a scanner, before child lists and totals exist.
pub struct RawNodes {
    pub parent: Vec<u32>,
    pub name_off: Vec<u32>,
    pub name_len: Vec<u16>,
    pub names: String,
    pub size: Vec<u64>,
    pub alloc: Vec<u64>,
    pub flags: Vec<u8>,
}

impl RawNodes {
    pub fn with_capacity(n: usize, name_bytes: usize) -> Self {
        RawNodes {
            parent: Vec::with_capacity(n),
            name_off: Vec::with_capacity(n),
            name_len: Vec::with_capacity(n),
            names: String::with_capacity(name_bytes),
            size: Vec::with_capacity(n),
            alloc: Vec::with_capacity(n),
            flags: Vec::with_capacity(n),
        }
    }
}

pub struct Tree {
    pub generation: u64,
    pub mode: &'static str,
    /// Absolute path of `root` (e.g. `C:\` or `D:\Games`).
    pub base_path: String,
    pub root: u32,
    /// Node the user asked to scan (== root unless a sub-folder was located inside an MFT scan).
    pub scan_root: u32,
    pub root_name: String,
    pub parent: Vec<u32>,
    pub name_off: Vec<u32>,
    pub name_len: Vec<u16>,
    pub names: String,
    pub size: Vec<u64>,
    pub alloc: Vec<u64>,
    pub files: Vec<u32>,
    pub dirs: Vec<u32>,
    pub flags: Vec<u8>,
    pub cstart: Vec<u32>,
    pub clist: Vec<u32>,
}

impl Tree {
    /// Builds child lists (CSR) and recursive totals. Nodes unreachable from `root`
    /// (unused MFT records, orphans, cycles) simply never appear in any child list.
    pub fn build(
        raw: RawNodes,
        root: u32,
        base_path: String,
        root_name: String,
        mode: &'static str,
    ) -> Tree {
        let RawNodes {
            parent,
            name_off,
            name_len,
            names,
            mut size,
            mut alloc,
            mut flags,
        } = raw;
        let n = parent.len();
        let r = root as usize;
        flags[r] |= F_DIR;

        let is_child = |i: usize, parent: &[u32], flags: &[u8]| -> bool {
            let p = parent[i];
            i != r && p != NONE && (p as usize) < n && flags[p as usize] & F_DIR != 0
        };

        // Counting sort of children by parent.
        let mut cstart = vec![0u32; n + 1];
        for i in 0..n {
            if is_child(i, &parent, &flags) {
                cstart[parent[i] as usize + 1] += 1;
            }
        }
        for i in 0..n {
            cstart[i + 1] += cstart[i];
        }
        let total = cstart[n] as usize;
        let mut clist = vec![0u32; total];
        let mut cursor: Vec<u32> = cstart[..n].to_vec();
        for i in 0..n {
            if is_child(i, &parent, &flags) {
                let p = parent[i] as usize;
                clist[cursor[p] as usize] = i as u32;
                cursor[p] += 1;
            }
        }
        drop(cursor);

        // BFS order from root, then accumulate bottom-up.
        let mut order: Vec<u32> = Vec::with_capacity(total + 1);
        order.push(root);
        let mut head = 0;
        while head < order.len() {
            let v = order[head] as usize;
            head += 1;
            for k in cstart[v]..cstart[v + 1] {
                order.push(clist[k as usize]);
            }
        }
        let mut files = vec![0u32; n];
        let mut dirs = vec![0u32; n];
        for &v in order.iter().skip(1).rev() {
            let v = v as usize;
            let p = parent[v] as usize;
            size[p] += size[v];
            alloc[p] += alloc[v];
            if flags[v] & F_DIR != 0 {
                files[p] += files[v];
                dirs[p] += dirs[v] + 1;
            } else {
                files[p] += 1;
            }
        }
        // Clear stale flags on unreachable nodes is unnecessary: they are never listed.
        flags.shrink_to_fit();

        Tree {
            generation: 0,
            mode,
            base_path,
            root,
            scan_root: root,
            root_name,
            parent,
            name_off,
            name_len,
            names,
            size,
            alloc,
            files,
            dirs,
            flags,
            cstart,
            clist,
        }
    }

    #[inline]
    pub fn valid(&self, id: u32) -> bool {
        (id as usize) < self.parent.len() && self.flags[id as usize] & F_DELETED == 0
    }

    #[inline]
    pub fn is_dir(&self, id: u32) -> bool {
        self.flags[id as usize] & F_DIR != 0
    }

    #[inline]
    pub fn name(&self, id: u32) -> &str {
        if id == self.root {
            return &self.root_name;
        }
        let o = self.name_off[id as usize] as usize;
        &self.names[o..o + self.name_len[id as usize] as usize]
    }

    #[inline]
    pub fn value(&self, id: u32, m: Metric) -> u64 {
        match m {
            Metric::Alloc => self.alloc[id as usize],
            Metric::Size => self.size[id as usize],
        }
    }

    /// Live (non-deleted) children.
    pub fn children(&self, id: u32) -> impl Iterator<Item = u32> + '_ {
        let i = id as usize;
        self.clist[self.cstart[i] as usize..self.cstart[i + 1] as usize]
            .iter()
            .copied()
            .filter(move |&c| self.flags[c as usize] & F_DELETED == 0)
    }

    pub fn path(&self, id: u32) -> String {
        let mut parts: Vec<&str> = Vec::new();
        let mut cur = id;
        let mut guard = 0;
        while cur != self.root && cur != NONE && guard < 4096 {
            parts.push(self.name(cur));
            cur = self.parent[cur as usize];
            guard += 1;
        }
        let mut s = self.base_path.clone();
        for (k, p) in parts.iter().rev().enumerate() {
            if k > 0 || !s.ends_with('\\') {
                s.push('\\');
            }
            s.push_str(p);
        }
        s
    }

    /// Ancestors from scan_root down to `id` (inclusive).
    pub fn crumbs(&self, id: u32) -> Vec<u32> {
        let mut v = vec![id];
        let mut cur = id;
        while cur != self.scan_root && cur != self.root {
            cur = self.parent[cur as usize];
            if cur == NONE {
                break;
            }
            v.push(cur);
        }
        v.reverse();
        v
    }

    /// True if `id` is `anc` or lies beneath it.
    pub fn is_within(&self, id: u32, anc: u32) -> bool {
        let mut cur = id;
        loop {
            if cur == anc {
                return true;
            }
            if cur == self.root || cur == NONE {
                return false;
            }
            cur = self.parent[cur as usize];
        }
    }

    /// Case-insensitive lookup of a path relative to `root` (components separated by `\`).
    pub fn find_relative(&self, rel: &str) -> Option<u32> {
        let mut cur = self.root;
        for comp in rel.split('\\').filter(|c| !c.is_empty()) {
            let lc = comp.to_lowercase();
            cur = self.children(cur).find(|&c| {
                self.name(c).eq_ignore_ascii_case(comp) || self.name(c).to_lowercase() == lc
            })?;
        }
        Some(cur)
    }

    pub fn sorted_children(&self, id: u32, m: Metric) -> Vec<u32> {
        let mut v: Vec<u32> = self.children(id).collect();
        v.sort_unstable_by_key(|&c| Reverse(self.value(c, m)));
        v
    }

    /// Iterative DFS over the live subtree of `id` (excluding `id`).
    pub fn for_each_descendant(&self, id: u32, mut f: impl FnMut(u32)) {
        let mut stack = vec![id];
        while let Some(v) = stack.pop() {
            for c in self.children(v) {
                f(c);
                if self.flags[c as usize] & F_DIR != 0 {
                    stack.push(c);
                }
            }
        }
    }

    pub fn largest_files(&self, id: u32, m: Metric, limit: usize) -> Vec<u32> {
        let limit = limit.max(1);
        let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::with_capacity(limit + 1);
        self.for_each_descendant(id, |c| {
            if self.flags[c as usize] & F_DIR == 0 {
                let v = self.value(c, m);
                if heap.len() < limit {
                    heap.push(Reverse((v, c)));
                } else if v > heap.peek().unwrap().0 .0 {
                    heap.pop();
                    heap.push(Reverse((v, c)));
                }
            }
        });
        let mut out: Vec<(u64, u32)> = heap.into_iter().map(|Reverse(x)| x).collect();
        out.sort_unstable_by(|a, b| b.cmp(a));
        out.into_iter().map(|(_, c)| c).collect()
    }

    /// (ext, count, size, alloc)
    pub fn file_types(&self, id: u32) -> Vec<(String, u64, u64, u64)> {
        let mut map: HashMap<Box<str>, (u64, u64, u64)> = HashMap::new();
        let mut buf = String::new();
        self.for_each_descendant(id, |c| {
            if self.flags[c as usize] & F_DIR != 0 {
                return;
            }
            let name = self.name(c);
            let ext = match name.rfind('.') {
                Some(p) if p > 0 && name.len() - p - 1 <= 12 => &name[p + 1..],
                _ => "",
            };
            buf.clear();
            buf.extend(ext.chars().flat_map(|ch| ch.to_lowercase()));
            let e = match map.get_mut(buf.as_str()) {
                Some(e) => e,
                None => map.entry(buf.clone().into_boxed_str()).or_insert((0, 0, 0)),
            };
            e.0 += 1;
            e.1 += self.size[c as usize];
            e.2 += self.alloc[c as usize];
        });
        map.into_iter()
            .map(|(k, v)| (k.into_string(), v.0, v.1, v.2))
            .collect()
    }

    /// Marks `id` deleted and subtracts its totals from every ancestor.
    pub fn remove(&mut self, id: u32) {
        let i = id as usize;
        if self.flags[i] & F_DELETED != 0 || id == self.root {
            return;
        }
        let (s, a) = (self.size[i], self.alloc[i]);
        let dir = self.flags[i] & F_DIR != 0;
        let (f, d) = if dir {
            (self.files[i], self.dirs[i] + 1)
        } else {
            (1, 0)
        };
        self.flags[i] |= F_DELETED;
        let mut cur = self.parent[i];
        let mut guard = 0;
        while cur != NONE && guard < 4096 {
            let c = cur as usize;
            self.size[c] = self.size[c].saturating_sub(s);
            self.alloc[c] = self.alloc[c].saturating_sub(a);
            self.files[c] = self.files[c].saturating_sub(f);
            self.dirs[c] = self.dirs[c].saturating_sub(d);
            if cur == self.root {
                break;
            }
            cur = self.parent[c];
            guard += 1;
        }
    }

    pub fn is_deleted_or_under_deleted(&self, id: u32) -> bool {
        let mut cur = id;
        loop {
            if self.flags[cur as usize] & F_DELETED != 0 {
                return true;
            }
            if cur == self.root {
                return false;
            }
            cur = self.parent[cur as usize];
            if cur == NONE {
                return false;
            }
        }
    }
}
