//! Domain error type shared across the core crate. Internal errors stay
//! typed; the Tauri layer maps `SkinError` into a serializable DTO with a
//! stable `code` + `message` (+ optional `retryAfterMs`).

use crate::codec::FormatError;
use crate::normalize::NormalizeError;

/// Stable error codes mirroring the old Node API_ERRORS.
pub mod codes {
    pub const BAD_REQUEST: &str = "BAD_REQUEST";
    pub const NOT_FOUND: &str = "NOT_FOUND";
    pub const CONFLICT: &str = "CONFLICT";
    pub const REVISION_MISMATCH: &str = "REVISION_MISMATCH";
    pub const PAYLOAD_TOO_LARGE: &str = "PAYLOAD_TOO_LARGE";
    pub const FETCH_FAILED: &str = "FETCH_FAILED";
    pub const FETCH_TIMEOUT: &str = "FETCH_TIMEOUT";
    pub const FETCH_REDIRECT: &str = "FETCH_REDIRECT";
    pub const FETCH_FORBIDDEN_ADDRESS: &str = "FETCH_FORBIDDEN_ADDRESS";
    pub const PLAYER_NOT_FOUND: &str = "PLAYER_NOT_FOUND";
    pub const PLAYER_NO_SKIN: &str = "PLAYER_NO_SKIN";
    pub const PLAYER_RATE_LIMITED: &str = "PLAYER_RATE_LIMITED";
    pub const PLAYER_SERVICE_UNAVAILABLE: &str = "PLAYER_SERVICE_UNAVAILABLE";
    pub const FORMAT_ERROR: &str = "FORMAT_ERROR";
    pub const JOB_CANCELLED: &str = "JOB_CANCELLED";
    pub const TAG_CYCLE: &str = "TAG_CYCLE";
    pub const TAG_DEPTH: &str = "TAG_DEPTH";
    pub const TAG_NAME_CONFLICT: &str = "TAG_NAME_CONFLICT";
    pub const TAG_HAS_CHILDREN: &str = "TAG_HAS_CHILDREN";
    pub const FOLDER_CYCLE: &str = "FOLDER_CYCLE";
    pub const FOLDER_DEPTH: &str = "FOLDER_DEPTH";
    pub const FOLDER_NAME_CONFLICT: &str = "FOLDER_NAME_CONFLICT";
    pub const FOLDER_NOT_EMPTY: &str = "FOLDER_NOT_EMPTY";
    pub const INTERNAL: &str = "INTERNAL";
}

#[derive(Debug, thiserror::Error)]
pub enum SkinError {
    #[error("{code}: {message}")]
    Api { code: &'static str, message: String, retry_after_ms: Option<u64> },

    #[error(transparent)]
    Format(#[from] FormatError),

    #[error(transparent)]
    Normalize(#[from] NormalizeError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

impl SkinError {
    pub fn api(code: &'static str, message: impl Into<String>) -> Self {
        SkinError::Api { code, message: message.into(), retry_after_ms: None }
    }

    pub fn api_retry(code: &'static str, message: impl Into<String>, retry_after_ms: u64) -> Self {
        SkinError::Api { code, message: message.into(), retry_after_ms: Some(retry_after_ms) }
    }

    /// Stable machine-readable code for the IPC layer.
    pub fn code(&self) -> &str {
        match self {
            SkinError::Api { code, .. } => code,
            SkinError::Format(e) => e.code,
            SkinError::Normalize(e) => e.code,
            SkinError::Io(_) | SkinError::Json(_) => codes::INTERNAL,
        }
    }

    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            SkinError::Api { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
    }
}

pub type SkinResult<T> = Result<T, SkinError>;
