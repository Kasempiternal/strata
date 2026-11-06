//! Raw NTFS Master File Table scanner.
//!
//! Reads `$MFT` straight off the volume (`\\.\C:`) with unbuffered, sector-aligned,
//! parallel 8 MiB reads and parses every FILE record in place. No directory is
//! ever opened, so a multi-million-file volume is indexed in seconds.
//! Requires administrator rights.

use crate::tree::{RawNodes, Tree, F_DIR, NONE};
use crate::Progress;
use rayon::prelude::*;
use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::sync::atomic::{AtomicBool, Ordering};

const SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
const FILE_FLAG_NO_BUFFERING: u32 = 0x2000_0000;
const ALIGN: usize = 4096;
const JOB_BYTES: u64 = 16 << 20;

const AT_ATTRIBUTE_LIST: u32 = 0x20;
const AT_FILE_NAME: u32 = 0x30;
const AT_DATA: u32 = 0x80;
const AT_INDEX_ALLOCATION: u32 = 0xA0;
const AT_BITMAP: u32 = 0xB0;
const AT_END: u32 = 0xFFFF_FFFF;
const REF_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;

// ---------------------------------------------------------------- aligned buffer

struct AlignedBuf {
    ptr: *mut u8,
    len: usize,
    layout: Layout,
}
unsafe impl Send for AlignedBuf {}

impl AlignedBuf {
    fn new(len: usize) -> AlignedBuf {
        let cap = round_up(len.max(ALIGN) as u64, ALIGN as u64) as usize;
        let layout = Layout::from_size_align(cap, ALIGN).expect("layout");
        let ptr = unsafe { alloc_zeroed(layout) };
        assert!(!ptr.is_null(), "out of memory");
        AlignedBuf { ptr, len, layout }
    }
    fn as_mut(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
    }
}
impl Drop for AlignedBuf {
    fn drop(&mut self) {
        unsafe { dealloc(self.ptr, self.layout) }
    }
}

#[inline]
fn round_up(v: u64, a: u64) -> u64 {
    v.div_ceil(a) * a
}
#[inline]
fn u16le(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
#[inline]
fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
#[inline]
fn u64le(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

fn open_volume(letter: char) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .share_mode(SHARE_ALL)
        .custom_flags(FILE_FLAG_NO_BUFFERING)
        .open(format!(r"\\.\{letter}:"))
}

fn read_exact_at(f: &File, mut off: u64, mut buf: &mut [u8]) -> io::Result<()> {
    while !buf.is_empty() {
        let n = f.seek_read(buf, off)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "short volume read",
            ));
        }
        off += n as u64;
        buf = &mut buf[n..];
    }
    Ok(())
}

// ---------------------------------------------------------------- geometry & runs

struct Geometry {
    cluster: u64,
    mft_offset: u64,
    rs: usize,
}

fn read_geometry(f: &File) -> Result<Geometry, String> {
    let mut b = AlignedBuf::new(ALIGN);
    read_exact_at(f, 0, b.as_mut()).map_err(|e| format!("boot sector: {e}"))?;
    let b = b.as_mut();
    if &b[3..11] != b"NTFS    " {
        return Err("not an NTFS volume".into());
    }
    let bps = u16le(b, 0x0B) as u64;
    let spc_raw = b[0x0D];
    let spc = if spc_raw > 0x80 {
        1u64 << (256 - spc_raw as u32)
    } else {
        spc_raw as u64
    };
    let cluster = bps * spc;
    let mft_lcn = u64le(b, 0x30);
    let cpr = b[0x40] as i8;
    let rs = if cpr > 0 {
        cpr as u64 * cluster
    } else {
        1u64 << (-(cpr as i32)) as u32
    };
    if cluster == 0 || !(256..=65536).contains(&rs) || bps < 512 {
        return Err("unexpected NTFS geometry".into());
    }
    Ok(Geometry {
        cluster,
        mft_offset: mft_lcn * cluster,
        rs: rs as usize,
    })
}

/// One contiguous piece of the $MFT stream. `disk == None` for sparse runs.
#[derive(Clone, Copy)]
struct Extent {
    start: u64,
    len: u64,
    disk: Option<u64>,
}

/// Decodes a mapping-pairs array into extents (byte units, stream offsets from `start_vcn`).
fn decode_runs(runs: &[u8], start_vcn: u64, cluster: u64, out: &mut Vec<Extent>) {
    let mut p = 0usize;
    let mut vcn = start_vcn;
    let mut lcn: i64 = 0;
    while p < runs.len() && runs[p] != 0 {
        let h = runs[p];
        let ls = (h & 0x0F) as usize;
        let os = (h >> 4) as usize;
        p += 1;
        if ls == 0 || ls > 8 || os > 8 || p + ls + os > runs.len() {
            break;
        }
        let mut len: u64 = 0;
        for i in 0..ls {
            len |= (runs[p + i] as u64) << (8 * i);
        }
        p += ls;
        let disk = if os == 0 {
            None
        } else {
            let mut d: i64 = 0;
            for i in 0..os {
                d |= (runs[p + i] as i64) << (8 * i);
            }
            let shift = 64 - 8 * os as u32;
            d = (d << shift) >> shift; // sign-extend
            lcn += d;
            Some(lcn as u64 * cluster)
        };
        p += os;
        out.push(Extent {
            start: vcn * cluster,
            len: len * cluster,
            disk,
        });
        vcn += len;
    }
}

/// Reads `buf.len()` bytes of the $MFT stream starting at stream offset `start`.
fn read_stream(f: &File, ext: &[Extent], start: u64, buf: &mut [u8]) -> io::Result<()> {
    let end = start + buf.len() as u64;
    let mut pos = start;
    while pos < end {
        let i = ext.partition_point(|e| e.start + e.len <= pos);
        let dst_off = (pos - start) as usize;
        if i >= ext.len() || ext[i].start > pos {
            // Gap / beyond mapped data: zero-fill until the next extent.
            let stop = if i < ext.len() {
                ext[i].start.min(end)
            } else {
                end
            };
            buf[dst_off..(stop - start) as usize].fill(0);
            pos = stop;
            continue;
        }
        let e = ext[i];
        let inner = pos - e.start;
        let n = (e.len - inner).min(end - pos);
        let dst = &mut buf[dst_off..dst_off + n as usize];
        match e.disk {
            Some(d) => read_exact_at(f, d + inner, dst)?,
            None => dst.fill(0),
        }
        pos += n;
    }
    Ok(())
}

/// Applies the update-sequence fixups. Returns false if the record is not a valid FILE record.
fn fixup(rec: &mut [u8]) -> bool {
    if rec.len() < 48 || &rec[0..4] != b"FILE" {
        return false;
    }
    let off = u16le(rec, 4) as usize;
    let cnt = u16le(rec, 6) as usize;
    if cnt < 2 || off + cnt * 2 > rec.len() {
        return false;
    }
    let stride = rec.len() / (cnt - 1);
    if stride < 2 {
        return false;
    }
    let (u0, u1) = (rec[off], rec[off + 1]);
    for i in 1..cnt {
        let end = i * stride - 2;
        if rec[end] != u0 || rec[end + 1] != u1 {
            return false;
        }
        rec[end] = rec[off + 2 * i];
        rec[end + 1] = rec[off + 2 * i + 1];
    }
    true
}

/// Iterates (type, attribute bytes) of a fixed-up record.
fn attributes(rec: &[u8]) -> impl Iterator<Item = (u32, &[u8])> {
    let used = (u32le(rec, 0x18) as usize).min(rec.len());
    let mut off = u16le(rec, 0x14) as usize;
    std::iter::from_fn(move || {
        if off + 16 > used {
            return None;
        }
        let ty = u32le(rec, off);
        if ty == AT_END {
            return None;
        }
        let len = u32le(rec, off + 4) as usize;
        if len < 16 || off + len > used {
            return None;
        }
        let a = &rec[off..off + len];
        off += len;
        Some((ty, a))
    })
}

#[inline]
fn resident_value(a: &[u8]) -> Option<&[u8]> {
    if a.len() < 0x18 || a[8] != 0 {
        return None;
    }
    let vlen = u32le(a, 0x10) as usize;
    let voff = u16le(a, 0x14) as usize;
    a.get(voff..voff.checked_add(vlen)?)
}

/// Collects the $MFT's own data extents, following an $ATTRIBUTE_LIST if the MFT is fragmented.
fn mft_extents(f: &File, g: &Geometry) -> Result<(Vec<Extent>, u64), String> {
    let rs = g.rs;
    let mut b = AlignedBuf::new(round_up(rs as u64, ALIGN as u64) as usize);
    read_exact_at(f, g.mft_offset, b.as_mut()).map_err(|e| format!("$MFT record: {e}"))?;
    let rec0 = &mut b.as_mut()[..rs];
    if !fixup(rec0) {
        return Err("$MFT record 0 is corrupt".into());
    }
    let mut ext = Vec::new();
    let mut data_size = 0u64;
    let mut list_refs: Vec<u64> = Vec::new();
    for (ty, a) in attributes(rec0) {
        match ty {
            AT_DATA if a[8] != 0 && a[9] == 0 => {
                let lowest = u64le(a, 0x10);
                if lowest == 0 {
                    data_size = u64le(a, 0x30);
                }
                let ro = u16le(a, 0x20) as usize;
                decode_runs(&a[ro.min(a.len())..], lowest, g.cluster, &mut ext);
            }
            AT_ATTRIBUTE_LIST => {
                let list: Vec<u8> = if a[8] == 0 {
                    resident_value(a).map(|v| v.to_vec()).unwrap_or_default()
                } else {
                    // Non-resident attribute list: read it through its own runs.
                    let mut le = Vec::new();
                    let ro = u16le(a, 0x20) as usize;
                    decode_runs(&a[ro.min(a.len())..], 0, g.cluster, &mut le);
                    let size = u64le(a, 0x30) as usize;
                    let mut lb = AlignedBuf::new(round_up(size as u64, ALIGN as u64) as usize);
                    match read_stream(f, &le, 0, lb.as_mut()) {
                        Ok(()) => lb.as_mut()[..size].to_vec(),
                        Err(_) => Vec::new(),
                    }
                };
                let mut p = 0usize;
                while p + 0x1A <= list.len() {
                    let ty = u32le(&list, p);
                    let rl = u16le(&list, p + 4) as usize;
                    if rl == 0 {
                        break;
                    }
                    let r = u64le(&list, p + 0x10) & REF_MASK;
                    if ty == AT_DATA && r != 0 && !list_refs.contains(&r) {
                        list_refs.push(r);
                    }
                    p += rl;
                }
            }
            _ => {}
        }
    }
    ext.sort_by_key(|e| e.start);
    // Extension records holding further $DATA runs of $MFT.
    for r in list_refs {
        let pos = r * rs as u64;
        let win = pos / ALIGN as u64 * ALIGN as u64;
        let wlen = round_up(pos + rs as u64 - win, ALIGN as u64) as usize;
        let mut wb = AlignedBuf::new(wlen);
        if read_stream(f, &ext, win, wb.as_mut()).is_err() {
            continue;
        }
        let o = (pos - win) as usize;
        let rec = &mut wb.as_mut()[o..o + rs];
        if !fixup(rec) {
            continue;
        }
        let mut more = Vec::new();
        for (ty, a) in attributes(rec) {
            if ty == AT_DATA && a[8] != 0 && a[9] == 0 {
                let lowest = u64le(a, 0x10);
                if lowest == 0 {
                    data_size = u64le(a, 0x30);
                }
                let ro = u16le(a, 0x20) as usize;
                decode_runs(&a[ro.min(a.len())..], lowest, g.cluster, &mut more);
            }
        }
        ext.extend(more);
        ext.sort_by_key(|e| e.start);
    }
    if ext.is_empty() || data_size == 0 {
        return Err("could not map $MFT".into());
    }
    Ok((ext, data_size))
}

/// Reads the $MFT:$BITMAP (bit i set = record i in use). `None` if unavailable.
fn mft_bitmap(f: &File, g: &Geometry) -> Option<Vec<u8>> {
    let rs = g.rs;
    let mut b = AlignedBuf::new(round_up(rs as u64, ALIGN as u64) as usize);
    read_exact_at(f, g.mft_offset, b.as_mut()).ok()?;
    let rec0 = &mut b.as_mut()[..rs];
    if !fixup(rec0) {
        return None;
    }
    for (ty, a) in attributes(rec0) {
        if ty != AT_BITMAP {
            continue;
        }
        if a[8] == 0 {
            return resident_value(a).map(|v| v.to_vec());
        }
        if u64le(a, 0x10) != 0 {
            return None;
        }
        let mut runs = Vec::new();
        let ro = u16le(a, 0x20) as usize;
        decode_runs(&a[ro.min(a.len())..], 0, g.cluster, &mut runs);
        let size = u64le(a, 0x30) as usize;
        let mut buf = AlignedBuf::new(round_up(size as u64, ALIGN as u64) as usize);
        read_stream(f, &runs, 0, buf.as_mut()).ok()?;
        return Some(buf.as_mut()[..size].to_vec());
    }
    None
}

#[inline]
fn in_use(bitmap: Option<&[u8]>, r: u64) -> bool {
    match bitmap {
        Some(b) => b
            .get((r >> 3) as usize)
            .is_none_or(|&x| x & (1 << (r & 7)) != 0),
        None => true,
    }
}

// ---------------------------------------------------------------- record parsing

struct ExtContrib {
    base: u32,
    size: u64,
    alloc: u64,
    parent: u32,
    name: Option<String>,
}

struct Job {
    r0: u64,
    r1: u64,
}

struct JobOut {
    parent: Vec<u32>,
    name_off: Vec<u32>,
    name_len: Vec<u16>,
    names: String,
    size: Vec<u64>,
    alloc: Vec<u64>,
    flags: Vec<u8>,
    ext: Vec<ExtContrib>,
}

struct Parsed<'a> {
    name: Option<&'a [u8]>, // UTF-16LE bytes
    parent: u32,
    size: u64,
    alloc: u64,
}

fn parse_attrs(rec: &[u8], idx: u64) -> Parsed<'_> {
    let mut best_ns = u8::MAX;
    let mut out = Parsed {
        name: None,
        parent: NONE,
        size: 0,
        alloc: 0,
    };
    for (ty, a) in attributes(rec) {
        match ty {
            AT_FILE_NAME => {
                if let Some(v) = resident_value(a) {
                    if v.len() < 0x42 {
                        continue;
                    }
                    let nl = v[0x40] as usize;
                    let ns = v[0x41];
                    if 0x42 + nl * 2 > v.len() {
                        continue;
                    }
                    // Prefer Win32 / POSIX / Win32&DOS long names over pure DOS 8.3 names.
                    let rank = if ns == 2 { 1 } else { 0 };
                    if out.name.is_none() || rank < best_ns {
                        best_ns = rank;
                        let p = u64le(v, 0) & REF_MASK;
                        out.parent = if p > u32::MAX as u64 - 1 {
                            NONE
                        } else {
                            p as u32
                        };
                        out.name = Some(&v[0x42..0x42 + nl * 2]);
                    }
                }
            }
            AT_DATA => {
                let named = a[9] != 0;
                if a[8] == 0 {
                    if !named {
                        out.size += u32le(a, 0x10) as u64;
                    }
                } else if a.len() >= 0x40 && u64le(a, 0x10) == 0 {
                    let flags = u16le(a, 0x0C);
                    let asz = u64le(a, 0x28);
                    let dsz = u64le(a, 0x30);
                    let real_alloc =
                        if flags & 0x8001 != 0 && u16le(a, 0x20) >= 0x48 && a.len() >= 0x48 {
                            u64le(a, 0x40)
                        } else {
                            asz
                        };
                    if !named {
                        out.size += dsz;
                        out.alloc += real_alloc;
                    } else if idx >= 16 {
                        out.alloc += real_alloc; // alternate data streams use disk space
                    }
                }
            }
            AT_INDEX_ALLOCATION if a[8] != 0 && a.len() >= 0x40 && u64le(a, 0x10) == 0 => {
                out.alloc += u64le(a, 0x28);
            }
            _ => {}
        }
    }
    out
}

fn push_utf16(dst: &mut String, bytes: &[u8]) {
    let it = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&c| u16::from_le_bytes(c));
    for ch in char::decode_utf16(it) {
        dst.push(ch.unwrap_or('\u{FFFD}'));
    }
}

fn run_job(
    pool: &[File],
    ext: &[Extent],
    bitmap: Option<&[u8]>,
    rs: usize,
    job: &Job,
    prog: &Progress,
    cancel: &AtomicBool,
) -> Result<JobOut, String> {
    let n = (job.r1 - job.r0) as usize;
    let mut out = JobOut {
        parent: vec![NONE; n],
        name_off: vec![0; n],
        name_len: vec![0; n],
        names: String::with_capacity(n * 16),
        size: vec![0; n],
        alloc: vec![0; n],
        flags: vec![0; n],
        ext: Vec::new(),
    };
    if cancel.load(Ordering::Relaxed) {
        return Ok(out);
    }
    // One long-lived handle per worker thread: the first read on a fresh volume
    // handle is very expensive, so handles are opened once per scan and reused.
    let f = &pool[rayon::current_thread_index().unwrap_or(0) % pool.len()];
    let bytes = n * rs;
    let mut buf = AlignedBuf::new(round_up(bytes as u64, ALIGN as u64) as usize);
    {
        // Read only spans that contain in-use records (per $MFT:$BITMAP). Gaps shorter than
        // GAP records are read through, since one larger I/O beats two small ones.
        // Unread records stay zeroed and fail the "FILE" signature check.
        const GAP: u64 = 256;
        let step = (ALIGN / rs).max(1) as u64; // records per aligned unit
        let full = buf.as_mut();
        let mut r = job.r0;
        while r < job.r1 {
            if !in_use(bitmap, r) {
                r += 1;
                continue;
            }
            let start = r;
            let mut end = r + 1;
            let mut gap = 0u64;
            let mut q = r + 1;
            while q < job.r1 && gap <= GAP {
                if in_use(bitmap, q) {
                    end = q + 1;
                    gap = 0;
                } else {
                    gap += 1;
                }
                q += 1;
            }
            let a = job.r0 + (start - job.r0) / step * step;
            let b = (job.r0 + (end - job.r0).div_ceil(step) * step)
                .min(job.r0 + (full.len() / rs) as u64);
            let lo = ((a - job.r0) as usize) * rs;
            let flen = full.len();
            let hi =
                (round_up(((b - job.r0) as usize * rs) as u64, ALIGN as u64) as usize).min(flen);
            read_stream(f, ext, a * rs as u64, &mut full[lo..hi])
                .map_err(|e| format!("read $MFT: {e}"))?;
            r = end;
        }
    }
    let data = &mut buf.as_mut()[..bytes];
    let mut used_files = 0u64;
    let mut bytes_alloc = 0u64;
    for k in 0..n {
        let idx = job.r0 + k as u64;
        if idx == 8 {
            continue; // $BadClus: its $Bad stream spans the whole volume
        }
        let rec = &mut data[k * rs..(k + 1) * rs];
        if !fixup(rec) {
            continue;
        }
        let rflags = u16le(rec, 0x16);
        if rflags & 1 == 0 {
            continue; // not in use
        }
        let is_dir = rflags & 2 != 0;
        let base = u64le(rec, 0x20) & REF_MASK;
        let p = parse_attrs(rec, idx);
        if base != 0 {
            if base < u32::MAX as u64 && (p.size != 0 || p.alloc != 0 || p.name.is_some()) {
                let name = p.name.map(|nb| {
                    let mut s = String::new();
                    push_utf16(&mut s, nb);
                    s
                });
                out.ext.push(ExtContrib {
                    base: base as u32,
                    size: p.size,
                    alloc: p.alloc,
                    parent: p.parent,
                    name,
                });
            }
            continue;
        }
        out.flags[k] = if is_dir { F_DIR } else { 0 };
        out.size[k] = p.size;
        out.alloc[k] = p.alloc;
        bytes_alloc += p.alloc;
        if let Some(nb) = p.name {
            let off = out.names.len();
            push_utf16(&mut out.names, nb);
            let len = (out.names.len() - off).min(u16::MAX as usize);
            out.parent[k] = p.parent;
            out.name_off[k] = off as u32;
            out.name_len[k] = len as u16;
            if !is_dir {
                used_files += 1;
            }
        }
    }
    prog.done.fetch_add(n as u64, Ordering::Relaxed);
    prog.files.fetch_add(used_files, Ordering::Relaxed);
    prog.bytes.fetch_add(bytes_alloc, Ordering::Relaxed);
    Ok(out)
}

/// Scans an entire NTFS volume. `letter` is the drive letter (e.g. 'C').
pub fn scan_volume(letter: char, prog: &Progress, cancel: &AtomicBool) -> Result<Tree, String> {
    let f = open_volume(letter).map_err(|e| {
        if e.raw_os_error() == Some(5) {
            "access denied (administrator rights required for MFT scan)".to_string()
        } else {
            format!("open {letter}: {e}")
        }
    })?;
    let timing = std::env::var_os("STRATA_TIMING").is_some();
    let t0 = std::time::Instant::now();
    let g = read_geometry(&f)?;
    let (ext, data_size) = mft_extents(&f, &g)?;
    let rs = g.rs;
    let records = data_size / rs as u64;
    prog.total.store(records, Ordering::Relaxed);

    let per_job = (JOB_BYTES / rs as u64).max(1);
    let jobs: Vec<Job> = (0..records.div_ceil(per_job))
        .map(|j| Job {
            r0: j * per_job,
            r1: ((j + 1) * per_job).min(records),
        })
        .collect();

    let bitmap = mft_bitmap(&f, &g);
    drop(f);
    let threads = rayon::current_num_threads().max(1);
    let pool: Vec<File> = (0..threads)
        .map(|_| open_volume(letter))
        .collect::<io::Result<_>>()
        .map_err(|e| format!("open volume: {e}"))?;
    let outs: Vec<JobOut> = jobs
        .par_iter()
        .map(|j| run_job(&pool, &ext, bitmap.as_deref(), rs, j, prog, cancel))
        .collect::<Result<_, _>>()?;
    drop(pool);
    if timing {
        eprintln!(
            "[mft] read+parse {:?} ({} extents)",
            t0.elapsed(),
            ext.len()
        );
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }

    // Stitch job outputs into one record-indexed table.
    let n = records as usize;
    let name_bytes: usize = outs.iter().map(|o| o.names.len()).sum();
    let mut raw = RawNodes::with_capacity(n, name_bytes + 1024);
    let mut exts: Vec<ExtContrib> = Vec::new();
    for o in outs {
        let base = raw.names.len() as u32;
        raw.names.push_str(&o.names);
        raw.parent.extend_from_slice(&o.parent);
        raw.name_off.extend(o.name_off.iter().map(|&x| x + base));
        raw.name_len.extend_from_slice(&o.name_len);
        raw.size.extend_from_slice(&o.size);
        raw.alloc.extend_from_slice(&o.alloc);
        raw.flags.extend_from_slice(&o.flags);
        exts.extend(o.ext);
    }
    // Fold extension records into their base records.
    for e in exts {
        let b = e.base as usize;
        if b >= n {
            continue;
        }
        raw.size[b] += e.size;
        raw.alloc[b] += e.alloc;
        if raw.parent[b] == NONE {
            if let Some(name) = e.name {
                let off = raw.names.len();
                raw.names.push_str(&name);
                raw.parent[b] = e.parent;
                raw.name_off[b] = off as u32;
                raw.name_len[b] = (raw.names.len() - off).min(u16::MAX as usize) as u16;
            }
        }
    }
    prog.phase.store(2, Ordering::Relaxed);
    if timing {
        eprintln!("[mft] stitched {:?}", t0.elapsed());
    }
    let root = 5u32; // NTFS root directory record
    let t = Tree::build(
        raw,
        root,
        format!("{letter}:\\"),
        format!("{letter}:"),
        "mft",
    );
    if timing {
        eprintln!("[mft] tree built {:?}", t0.elapsed());
    }
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_runs_with_negative_offsets_and_sparse() {
        // run1: 0x18 clusters @ LCN 0x5634; run2: 0x10 clusters @ -0x100 relative; run3: sparse 4 clusters
        let runs = [
            0x21, 0x18, 0x34, 0x56, 0x21, 0x10, 0x00, 0xFF, 0x01, 0x04, 0x00,
        ];
        let mut out = Vec::new();
        decode_runs(&runs, 0, 4096, &mut out);
        assert_eq!(out.len(), 3);
        assert_eq!(
            (out[0].start, out[0].len, out[0].disk),
            (0, 0x18 * 4096, Some(0x5634 * 4096))
        );
        assert_eq!(
            (out[1].start, out[1].len, out[1].disk),
            (0x18 * 4096, 0x10 * 4096, Some((0x5634 - 0x100) * 4096))
        );
        assert_eq!(
            (out[2].start, out[2].len, out[2].disk),
            (0x28 * 4096, 4 * 4096, None)
        );
    }

    fn record_with_usa(rs: usize) -> Vec<u8> {
        let mut r = vec![0u8; rs];
        r[0..4].copy_from_slice(b"FILE");
        let sectors = rs / 512;
        r[4..6].copy_from_slice(&0x30u16.to_le_bytes()); // USA offset
        r[6..8].copy_from_slice(&((sectors + 1) as u16).to_le_bytes());
        r[0x30..0x32].copy_from_slice(&[0xAB, 0xCD]); // update sequence number
        for i in 1..=sectors {
            let end = i * 512 - 2;
            r[0x30 + 2 * i] = i as u8; // original bytes stored in the array
            r[0x30 + 2 * i + 1] = 0x77;
            r[end] = 0xAB;
            r[end + 1] = 0xCD;
        }
        r
    }

    #[test]
    fn fixup_restores_sector_tails() {
        let mut r = record_with_usa(1024);
        assert!(fixup(&mut r));
        assert_eq!(&r[510..512], &[1, 0x77]);
        assert_eq!(&r[1022..1024], &[2, 0x77]);
    }

    #[test]
    fn fixup_rejects_torn_or_foreign_records() {
        let mut r = record_with_usa(1024);
        r[1022] = 0; // torn write
        assert!(!fixup(&mut r));
        let mut r = record_with_usa(1024);
        r[0] = b'B'; // "BAAD"/garbage
        assert!(!fixup(&mut r));
    }
}
