//! Disk schema DTOs for library.json — field names, types and meanings are
//! identical to the Node implementation (schemaVersion 4). Rust-internal
//! naming is snake_case; serde maps to camelCase on disk.

use crate::codec::SkinModel;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 4;
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LicenseInfo {
    pub status: LicenseStatus,
    pub name: Option<String>,
    pub url: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LicenseStatus {
    #[default]
    Unspecified,
    Declared,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Provenance {
    pub author: Option<String>,
    pub source_name: Option<String>,
    pub source_url: Option<String>,
    pub source_note: Option<String>,
    pub original_created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub entry_id: String,
    pub skin_id: String,
    pub name: String,
    #[serde(default = "default_active")]
    pub active: bool,
    /// Directly attached tag IDs — flat labels only.
    pub tag_ids: Vec<String>,
    /// Archive location; null = 未归档.
    pub folder_id: Option<String>,
    pub favorite: bool,
    pub model: SkinModel,
    pub source: EntrySource,
    #[serde(default)]
    pub provenance: Provenance,
    #[serde(default)]
    pub license: LicenseInfo,
    #[serde(default)]
    pub note: String,
    /// ISO-8601.
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
}

fn default_active() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFileV4<'a> {
    pub schema_version: u32,
    pub revision: u64,
    pub tags: &'a [TagNode],
    pub folders: &'a [FolderNode],
    pub entries: &'a [LibraryEntry],
}

/// v3 file: same as v4 minus active/license/provenance/note.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFileV3 {
    pub schema_version: u32,
    #[serde(default = "default_revision")]
    pub revision: u64,
    #[serde(default)]
    pub tags: Vec<TagNode>,
    #[serde(default)]
    pub folders: Vec<FolderNode>,
    #[serde(default)]
    pub entries: Vec<LibraryEntryV3>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntryV3 {
    pub entry_id: String,
    pub skin_id: String,
    pub name: String,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    pub model: SkinModel,
    pub source: EntrySource,
    #[serde(default = "default_created_at")]
    pub created_at: String,
    #[serde(default = "default_created_at")]
    pub updated_at: String,
    #[serde(default = "default_revision_u64")]
    pub revision: u64,
}

fn default_revision() -> u64 {
    1
}
fn default_revision_u64() -> u64 {
    1
}
fn default_created_at() -> String {
    crate::storage::now_iso_public()
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
    pub entries: Vec<LibraryEntryV3>,
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
pub struct PortableSkinFileV3 {
    pub schema_version: u32,
    pub name: String,
    pub skin_id: String,
    pub skin_code: String,
    pub model: SkinModel,
    #[serde(default)]
    pub tag_paths: Vec<Vec<String>>,
    #[serde(default = "default_active")]
    pub active: bool,
    #[serde(default)]
    pub license: LicenseInfo,
    #[serde(default)]
    pub provenance: Provenance,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSkinFileV2 {
    pub schema_version: u32,
    pub name: String,
    #[serde(default)]
    pub tag_paths: Vec<Vec<String>>,
    pub skin_id: String,
    pub skin_code: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableSkinFileV1 {
    pub schema_version: u32,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub skin_id: String,
    pub skin_code: String,
}
