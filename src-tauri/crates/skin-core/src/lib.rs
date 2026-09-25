//! skin-core — Minecraft skin manager domain core.
//!
//! Independent of Tauri and the frontend: codec, PNG normalization, storage,
//! imports and the SSRF-guarded network stack. Receives a data directory and
//! exposes plain Rust APIs so `cargo test -p skin-core` covers the domain.

pub mod codec;
pub mod error;
pub mod imports;
pub mod normalize;
pub mod network;
pub mod storage;

pub use codec::SkinModel;
pub use error::{SkinError, SkinResult};
pub use imports::{ImportInput, ImportJob, ImportManager, JobState};
pub use storage::Storage;
