//! Strata scanning engine (usable headless; see examples/bench.rs).
pub mod mft;
pub mod tree;
pub mod walk;
pub mod winutil;

use std::sync::atomic::{AtomicU64, AtomicU8};

/// Shared scan counters, polled by the progress ticker.
#[derive(Default)]
pub struct Progress {
    pub phase: AtomicU8, // 0 mft, 1 walk, 2 build
    pub done: AtomicU64,
    pub total: AtomicU64,
    pub files: AtomicU64,
    pub bytes: AtomicU64,
}
