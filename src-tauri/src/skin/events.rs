//! Skin events: notify the frontend after mutations commit. Events are
//! notifications only — the Rust job registry and library snapshot remain
//! the source of truth (the frontend re-queries on receipt).

use crate::skin::state::SkinState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub const JOB_UPDATED_EVENT: &str = "skin://job-updated";
pub const LIBRARY_UPDATED_EVENT: &str = "skin://library-updated";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobUpdatedPayload {
    pub job_id: String,
    pub seq: u64,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUpdatedPayload {
    pub revision: u64,
    /// Which domain changed: "entries" | "tags" | "folders".
    pub domain: String,
}

/// Emit a job notification. Emit failures are logged, never fatal — a
/// successful save must not roll back because the event could not be sent.
pub fn emit_job_updated(app: &AppHandle, job: &skin_core::imports::ImportJob) {
    let payload = JobUpdatedPayload {
        job_id: job.job_id.clone(),
        seq: job.seq,
        state: format!("{:?}", job.state).to_lowercase(),
    };
    if let Err(e) = app.emit(JOB_UPDATED_EVENT, payload) {
        log::warn!("skin job event emit failed: {e}");
    }
}

/// Emit a library change notification after a successful commit.
pub fn emit_library_updated(app: &AppHandle, state: &State<'_, SkinState>, domain: &str) {
    let payload = LibraryUpdatedPayload {
        revision: state.service.library.revision(),
        domain: domain.to_string(),
    };
    if let Err(e) = app.emit(LIBRARY_UPDATED_EVENT, payload) {
        log::warn!("skin library event emit failed: {e}");
    }
}
