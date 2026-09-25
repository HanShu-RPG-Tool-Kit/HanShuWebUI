//! Disk schema DTOs for library.json — field names, types and meanings are
//! identical to the Node implementation (schemaVersion 3). Rust-internal
//! naming is snake_case; serde maps to camelCase on disk.

use crate::codec::SkinModel;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 3;
pub const MAX_TAG_DEPTH: usize = 8;
pub const MAX_FOLDER_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagNode {
    pub tag_id: String,
    pub name: String,
    /// Legacy; new UI treats tags as flat.
    pub parent_id: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub folder_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
}

/// Entry source — tagged union with a `kind` discriminator, matching the old
/// JSON contract exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EntrySource {
    PngFile { #[serde(skip_serializing_if = "Option::is_none", default)] file_name: Option<String> },
    PngUrl { url: String },
    PlayerName { player_name: String, #[serde(skip_serializing_if = "Option::is_none", default)] uuid: Option<String> },
    SkinCode,
    SkinFile { #[serde(skip_serializing_if = "Option::is_none", default)] file_name: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub entry_id: String,
    pub skin_id: String,
    pub name: String,
    /// Directly attached tag IDs — flat labels only.
    pub tag_ids: Vec<String>,
    /// Archive location; null = 未归档.
    pub folder_id: Option<String>,
    pub favorite: bool,
    pub model: SkinModel,
    pub source: EntrySource,
    /// ISO-8601.
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFileV3<'a> {
    pub schema_version: u32,
    pub revision: u64,
    pub tags: &'a [TagNode],
    pub folders: &'a [FolderNode],
    pub entries: &'a [LibraryEntry],
}

/// v2 file: same as v3 minus folders; entries may carry a stray folderId.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFileV2 {
    pub schema_version: u32,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub tags: Vec<TagNode>,
    #[serde(default)]
    pub entries: Vec<LibraryEntry>,
}

/// v1 file: flat string tags per entry.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFileV1 {
    pub schema_version: u32,
    #[serde(default)]
    pub entries: Vec<LibraryFileV1Entry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFileV1Entry {
    #[serde(default)]
    pub entry_id: Option<String>,
    pub skin_id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
    pub model: SkinModel,
    pub source: EntrySource,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub revision: Option<u64>,
}

/// Portable .skin.json files.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSkinFileV2 {
    pub schema_version: u32,
    pub name: String,
    pub tag_paths: Vec<Vec<String>>,
    pub skin_id: String,
    pub skin_code: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSkinFileV1 {
    pub schema_version: u32,
    pub name: String,
    pub tags: Vec<String>,
    pub skin_id: String,
    pub skin_code: String,
}
