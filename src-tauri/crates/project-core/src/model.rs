use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

pub const SESSION_TTL: u64 = 60_000;
pub const LEASE_TTL: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Owner,
    Editor,
    Viewer,
}
impl Role {
    pub fn can_write(self) -> bool {
        self != Self::Viewer
    }
}

/// An authenticated identity, including non-human identities. Never a client connection.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub id: String,
    /// Login identifier; `name` is the display nickname.
    #[serde(default)]
    pub username: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    Folder,
    Progress,
    GoalDefinition,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: ResourceKind,
    #[ts(type = "number")]
    pub revision: u64,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInfo {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: ResourceKind,
    #[ts(type = "number")]
    pub revision: u64,
}
impl From<&Resource> for ResourceInfo {
    fn from(r: &Resource) -> Self {
        Self {
            id: r.id.clone(),
            parent_id: r.parent_id.clone(),
            name: r.name.clone(),
            kind: r.kind,
            revision: r.revision,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, TS)]
pub(crate) struct Credential {
    pub subject_id: String,
    pub digest: String,
}

#[derive(Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Project {
    pub version: u32,
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub subjects: BTreeMap<String, Subject>,
    pub grants: BTreeMap<String, Role>,
    pub credentials: Vec<Credential>,
    pub resources: BTreeMap<String, Resource>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilePresence {
    /// A public project-relative file path. Unsaved files may be announced before creation.
    pub path: String,
    /// The server-derived authority shared by a source and its language/voice assets.
    pub authority_id: String,
    /// An opaque skin entry identity used only for collaborator display, never for authority.
    /// It may reference a deleted entry whose local draft is being recovered.
    pub entry_id: Option<String>,
    /// Editor intent for free editors; managed progress editors derive this from their lease.
    /// This field never grants or proves write authority.
    pub activity: FileActivity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FileActivity {
    Viewing,
    Editing,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub subject_id: String,
    pub client_name: String,
    #[ts(type = "number")]
    pub expires_at: u64,
    pub resource_id: Option<String>,
    pub activity: String,
    /// Focus only; opening a file never grants a write lease.
    pub file_presence: Option<FilePresence>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub id: String,
    pub resource_id: String,
    pub session_id: String,
    #[ts(type = "number")]
    pub expires_at: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub subject: Subject,
    pub role: Role,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Monotonic for this running service, including ephemeral presence/lease updates.
    #[ts(type = "number")]
    pub status_version: u64,
    /// Server wall-clock milliseconds sampled when this snapshot is constructed.
    /// Clients use this as an anchor for lease/session expiry, not their own wall clock.
    #[ts(type = "number")]
    pub server_time: u64,
    pub project_id: String,
    pub project_name: String,
    #[ts(type = "number")]
    pub revision: u64,
    #[ts(type = "number")]
    pub files_revision: u64,
    pub session: Session,
    pub role: Role,
    pub members: Vec<Member>,
    pub resources: Vec<ResourceInfo>,
    pub sessions: Vec<Session>,
    pub leases: Vec<Lease>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::new("storage", "工程存储失败，原内容未提交")
    }
}
pub type Result<T> = std::result::Result<T, Error>;
