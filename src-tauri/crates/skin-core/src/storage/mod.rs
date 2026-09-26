//! On-disk storage: JSON index + content-addressed object files.
//!
//!   <root>/
//!     library.json   (+ library.json.bak, library.json.v1-migration-backup,
//!                     library.json.v3-migration-backup)
//!     objects/<skinId[0..2]>/<skinId>.hskin
//!     cache/png/<skinId>.png
//!     tmp/
//!
//! All mutations go through `Storage::mutate`, which serializes writes,
//! validates, builds a candidate snapshot, persists atomically (temp file +
//! rename + fsync), then swaps the in-memory snapshot. A failed persist leaves
//! the previous state untouched.

pub mod schema;

use crate::codec::{decode_skin_code, SkinModel};
use crate::error::{codes, SkinError, SkinResult};
use schema::*;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;

pub struct DataLayout {
    pub root: PathBuf,
    pub objects: PathBuf,
    pub cache_png: PathBuf,
    pub tmp: PathBuf,
    pub library_file: PathBuf,
    pub library_backup: PathBuf,
    pub migration_backup_v1: PathBuf,
    pub migration_backup_v3: PathBuf,
}

pub fn data_layout(root: &Path) -> DataLayout {
    DataLayout {
        root: root.to_path_buf(),
        objects: root.join("objects"),
        cache_png: root.join("cache").join("png"),
        tmp: root.join("tmp"),
        library_file: root.join("library.json"),
        library_backup: root.join("library.json.bak"),
        migration_backup_v1: root.join("library.json.v1-migration-backup"),
        migration_backup_v3: root.join("library.json.v3-migration-backup"),
    }
}

/// In-memory snapshot; replaced wholesale on each successful commit.
#[derive(Debug, Clone, Default)]
struct Snapshot {
    tags: Vec<TagNode>,
    folders: Vec<FolderNode>,
    entries: Vec<LibraryEntry>,
    revision: u64,
}

impl Snapshot {
    fn tag_ids(&self) -> HashSet<String> {
        self.tags.iter().map(|t| t.tag_id.clone()).collect()
    }
    fn folder_ids(&self) -> HashSet<String> {
        self.folders.iter().map(|f| f.folder_id.clone()).collect()
    }
}

/// NFC + trim — tag/folder name identity within a sibling group.
pub fn normalize_name(name: &str) -> String {
    name.trim().nfc().collect::<String>()
}

fn now_iso() -> String {
    now_iso_public()
}

/// RFC3339 timestamp used across the crate (also reused by imports).
pub fn now_iso_public() -> String {
    // RFC3339 with millisecond precision from the system clock.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // Civil-from-days conversion (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Atomic write: temp file in the target directory, fsync, rename over target.
fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(data)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)?;
    Ok(())
}

pub struct MigrationReport {
    pub migrated: bool,
    pub from_version: u32,
    pub to_version: u32,
    pub tag_count: usize,
    pub entry_count: usize,
    pub merged_names: Vec<String>,
}

// ---------------------------------------------------------------------------
// Query types (IPC-facing; three-state folder filter is explicit)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagScope {
    Subtree,
    Direct,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagMatch {
    Any,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntrySortBy {
    Name,
    #[serde(rename = "createdAt")]
    CreatedAt,
    #[serde(rename = "updatedAt")]
    UpdatedAt,
    Author,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryScope {
    All,
    Unfiled,
    Folder,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryQuery {
    pub search: Option<String>,
    pub tag_ids: Vec<String>,
    pub exclude_tag_ids: Vec<String>,
    pub tag_scope: Option<TagScope>,
    pub tag_match: Option<TagMatch>,
    pub untagged: bool,
    pub favorite: Option<bool>,
    pub active: Option<bool>,
    pub models: Vec<SkinModel>,
    pub include_license_names: Vec<String>,
    pub exclude_license_names: Vec<String>,
    /// true → only entries whose license is unspecified; false → only declared.
    pub license_unspecified: Option<bool>,
    pub author: Option<String>,
    pub created_from: Option<String>,
    pub created_to: Option<String>,
    pub scope: Option<EntryScope>,
    pub folder_id: Option<String>,
    /// Present + folder_id set → include descendant folders.
    pub include_subfolders: bool,
    pub sort_by: Option<EntrySortBy>,
    pub sort_direction: Option<SortDirection>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
pub struct LibraryPage {
    pub entries: Vec<LibraryEntry>,
    pub total: usize,
    pub page: u32,
    pub page_size: u32,
    pub revision: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagWithStats {
    pub tag_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub direct_count: usize,
    pub subtree_count: usize,
    pub path: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderWithStats {
    pub folder_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub direct_count: usize,
    pub subtree_count: usize,
    pub path: Vec<String>,
}

// ---------------------------------------------------------------------------
// Patch types — three-state fields via explicit enums
// ---------------------------------------------------------------------------

/// Null | Value(T) — presence in the JSON distinguishes "leave unchanged"
/// (field missing → Option::None) from "clear" (null) and "set" (value).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
pub enum PatchField<T> {
    Null,
    Value(T),
}

impl<T> PatchField<T> {
    fn as_option(&self) -> Option<&T> {
        match self {
            PatchField::Null => None,
            PatchField::Value(v) => Some(v),
        }
    }
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PatchTag {
    pub expected_revision: Option<u64>,
    pub name: Option<String>,
    pub parent_id: Option<PatchField<String>>,
    pub sort_order: Option<i64>,
    pub sort_siblings_by_name: bool,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PatchFolder {
    pub name: Option<String>,
    pub parent_id: Option<PatchField<String>>,
    pub sort_order: Option<i64>,
    pub sort_siblings_by_name: bool,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PatchEntry {
    pub name: Option<String>,
    pub tag_ids: Option<Vec<String>>,
    pub add_tag_ids: Option<Vec<String>>,
    pub remove_tag_ids: Option<Vec<String>>,
    pub favorite: Option<bool>,
    pub folder_id: Option<PatchField<String>>,
    pub active: Option<bool>,
    pub license: Option<LicenseInfo>,
    pub provenance: Option<Provenance>,
    pub note: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BatchPatch {
    pub entry_ids: Vec<String>,
    pub add_tag_ids: Option<Vec<String>>,
    pub remove_tag_ids: Option<Vec<String>>,
    pub folder_id: Option<PatchField<String>>,
    pub active: Option<bool>,
    pub expected_revisions: Option<Vec<u64>>,
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

pub struct Storage {
    layout: DataLayout,
    snapshot: Mutex<Arc<Snapshot>>,
    migration_report: Mutex<Option<MigrationReport>>,
}

impl Storage {
    /// Open (or create) a library at `root`. Migrates v1/v2/v3 forward; refuses
    /// to open unknown newer versions.
    pub fn open(root: &Path) -> SkinResult<Self> {
        let layout = data_layout(root);
        fs::create_dir_all(&layout.objects)?;
        fs::create_dir_all(&layout.cache_png)?;
        fs::create_dir_all(&layout.tmp)?;
        let storage = Self {
            layout,
            snapshot: Mutex::new(Arc::new(Snapshot::default())),
            migration_report: Mutex::new(None),
        };
        storage.load_index()?;
        storage.sweep_tmp();
        Ok(storage)
    }

    pub fn layout(&self) -> &DataLayout {
        &self.layout
    }

    pub fn migration_report(&self) -> Option<MigrationReport> {
        self.migration_report.lock().unwrap().take()
    }

    fn load_index(&self) -> SkinResult<()> {
        let raw = match fs::read_to_string(&self.layout.library_file) {
            Ok(raw) => raw,
            Err(_) => match fs::read_to_string(&self.layout.library_backup) {
                Ok(raw) => raw,
                Err(_) => {
                    // No library at all → genuinely empty, safe to create.
                    let snap = Snapshot::default();
                    self.persist(&snap)?;
                    *self.snapshot.lock().unwrap() = Arc::new(snap);
                    return Ok(());
                }
            },
        };
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => {
                // Corrupt main file — one retry from the backup.
                let backup = fs::read_to_string(&self.layout.library_backup).map_err(|_| {
                    SkinError::api(
                        codes::INTERNAL,
                        "library.json and library.json.bak are both unreadable; \
                         refusing to overwrite with an empty library",
                    )
                })?;
                serde_json::from_str(&backup).map_err(|_| {
                    SkinError::api(
                        codes::INTERNAL,
                        "library.json and library.json.bak are both corrupt; \
                         refusing to overwrite with an empty library",
                    )
                })?
            }
        };
        let version = parsed.get("schemaVersion").and_then(|v| v.as_u64());
        let snap = match version {
            Some(4) => {
                let v4: LibraryFileV4Owned = serde_json::from_value(parsed).map_err(|e| {
                    SkinError::api(codes::INTERNAL, format!("library.json v4 invalid: {e}"))
                })?;
                Snapshot {
                    tags: v4.tags,
                    folders: v4.folders,
                    entries: v4.entries,
                    revision: v4.revision,
                }
            }
            Some(3) => {
                let v3: LibraryFileV3 = serde_json::from_value(parsed).map_err(|e| {
                    SkinError::api(codes::INTERNAL, format!("library.json v3 invalid: {e}"))
                })?;
                self.migrate_from_v3(v3, &raw)?
            }
            Some(2) => {
                let mut v2: LibraryFileV2 = serde_json::from_value(parsed).map_err(|e| {
                    SkinError::api(codes::INTERNAL, format!("library.json v2 invalid: {e}"))
                })?;
                // v2 → v4: entries become 未归档 (no folders exist in v2, so
                // any stray folderId has no valid target and is dropped).
                for e in &mut v2.entries {
                    e.folder_id = None;
                }
                let v3 = LibraryFileV3 {
                    schema_version: 3,
                    revision: v2.revision,
                    tags: v2.tags,
                    folders: Vec::new(),
                    entries: v2.entries,
                };
                self.migrate_from_v3(v3, &raw)?
            }
            Some(1) | None => {
                // v1 (or a hand-written legacy file with the v1 shape).
                let v1: LibraryFileV1 = serde_json::from_value(parsed).map_err(|e| {
                    SkinError::api(codes::INTERNAL, format!("library.json v1 invalid: {e}"))
                })?;
                self.migrate_from_v1(v1, &raw)?
            }
            Some(v) => {
                return Err(SkinError::api(
                    codes::INTERNAL,
                    format!(
                        "library.json schemaVersion {v} is newer than supported (4); \
                         restore the pre-migration backup"
                    ),
                ));
            }
        };
        let snap = sanitize(snap);
        self.persist(&snap)?;
        *self.snapshot.lock().unwrap() = Arc::new(snap);
        Ok(())
    }

    /// Convert flat v1 string tags to root-level tag nodes, dedupe by NFC name.
    fn migrate_from_v1(&self, v1: LibraryFileV1, raw: &str) -> SkinResult<Snapshot> {
        let mut name_to_id: HashMap<String, String> = HashMap::new();
        let mut merged: Vec<String> = Vec::new();
        let mut tags: Vec<TagNode> = Vec::new();
        let mut order: i64 = 0;
        for e in &v1.entries {
            for t in &e.tags {
                let norm = normalize_name(t);
                if norm.is_empty() {
                    continue;
                }
                match name_to_id.get(&norm) {
                    None => {
                        let tag_id = new_id();
                        name_to_id.insert(norm.clone(), tag_id.clone());
                        tags.push(TagNode {
                            tag_id,
                            name: norm,
                            parent_id: None,
                            sort_order: order,
                        });
                        order += 1;
                    }
                    Some(_) if norm != *t => merged.push(t.clone()),
                    _ => {}
                }
            }
        }
        let entries = v1
            .entries
            .into_iter()
            .map(|e| {
                let mut ids: Vec<String> = Vec::new();
                let mut seen = HashSet::new();
                for t in &e.tags {
                    let norm = normalize_name(t);
                    if norm.is_empty() {
                        continue;
                    }
                    if let Some(id) = name_to_id.get(&norm) {
                        if seen.insert(id.clone()) {
                            ids.push(id.clone());
                        }
                    }
                }
                LibraryEntry {
                    entry_id: e.entry_id.unwrap_or_else(new_id),
                    skin_id: e.skin_id,
                    name: e.name,
                    active: true,
                    tag_ids: ids,
                    folder_id: None,
                    favorite: e.favorite,
                    model: e.model,
                    source: e.source,
                    provenance: Provenance::default(),
                    license: LicenseInfo::default(),
                    note: String::new(),
                    created_at: e.created_at.unwrap_or_else(now_iso),
                    updated_at: e.updated_at.unwrap_or_else(now_iso),
                    revision: e.revision.unwrap_or(1),
                }
            })
            .collect();
        let snap = Snapshot { tags, folders: Vec::new(), entries, revision: 1 };
        // Keep the untouched v1 file under a dedicated name before any v4 write.
        if !self.layout.migration_backup_v1.exists() {
            atomic_write(&self.layout.migration_backup_v1, raw.as_bytes())?;
        }
        *self.migration_report.lock().unwrap() = Some(MigrationReport {
            migrated: true,
            from_version: 1,
            to_version: SCHEMA_VERSION,
            tag_count: snap.tags.len(),
            entry_count: snap.entries.len(),
            merged_names: merged,
        });
        Ok(snap)
    }

    /// Migrate v3 (or v2-upgraded-to-v3) entries into v4 with new metadata defaults.
    fn migrate_from_v3(&self, v3: LibraryFileV3, raw: &str) -> SkinResult<Snapshot> {
        let entries = v3
            .entries
            .into_iter()
            .map(|e| LibraryEntry {
                entry_id: e.entry_id,
                skin_id: e.skin_id,
                name: e.name,
                active: true,
                tag_ids: e.tag_ids,
                folder_id: e.folder_id,
                favorite: e.favorite,
                model: e.model,
                source: e.source,
                provenance: Provenance::default(),
                license: LicenseInfo::default(),
                note: String::new(),
                created_at: e.created_at,
                updated_at: e.updated_at,
                revision: e.revision,
            })
            .collect();
        let snap = Snapshot {
            tags: v3.tags,
            folders: v3.folders,
            entries,
            revision: v3.revision,
        };
        if !self.layout.migration_backup_v3.exists() {
            atomic_write(&self.layout.migration_backup_v3, raw.as_bytes())?;
        }
        *self.migration_report.lock().unwrap() = Some(MigrationReport {
            migrated: true,
            from_version: 3,
            to_version: SCHEMA_VERSION,
            tag_count: snap.tags.len(),
            entry_count: snap.entries.len(),
            merged_names: Vec::new(),
        });
        Ok(snap)
    }

    fn sweep_tmp(&self) {
        let cutoff = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64 - 3_600_000)
            .unwrap_or(0);
        let Ok(names) = fs::read_dir(&self.layout.tmp) else {
            return;
        };
        for entry in names.flatten() {
            let p = entry.path();
            let Ok(meta) = fs::metadata(&p) else { continue };
            let Ok(mtime) = meta.modified() else { continue };
            if let Ok(age) = mtime.duration_since(UNIX_EPOCH) {
                if (age.as_millis() as i64) < cutoff {
                    continue; // newer than 1h — keep
                }
            }
            let _ = fs::remove_file(&p);
        }
    }

    /// Serialize the snapshot to disk (backup rotation + atomic replace).
    fn persist(&self, snap: &Snapshot) -> SkinResult<()> {
        let payload = LibraryFileV4 {
            schema_version: SCHEMA_VERSION,
            revision: snap.revision,
            tags: &snap.tags,
            folders: &snap.folders,
            entries: &snap.entries,
        };
        let json = serde_json::to_vec_pretty(&payload)?;
        // Rotate the previous good file into .bak before replacing.
        if self.layout.library_file.exists() {
            if let Err(e) = fs::copy(&self.layout.library_file, &self.layout.library_backup) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return Err(e.into());
                }
            }
        }
        atomic_write(&self.layout.library_file, &json)?;
        Ok(())
    }

    fn snapshot(&self) -> Arc<Snapshot> {
        self.snapshot.lock().unwrap().clone()
    }

    /// Run a mutation under the write lock: build a candidate from a clone,
    /// persist it, then swap the in-memory snapshot. A persist failure leaves
    /// the previous state intact.
    fn mutate<T>(&self, f: impl FnOnce(&mut Snapshot) -> SkinResult<T>) -> SkinResult<T> {
        let mut guard = self.snapshot.lock().unwrap();
        let mut candidate: Snapshot = (**guard).clone();
        let out = f(&mut candidate)?;
        self.persist(&candidate)?;
        *guard = Arc::new(candidate);
        Ok(out)
    }

    // ------------------------------------------------------------------
    // objects
    // ------------------------------------------------------------------

    /// Validate a skin code and store it as objects/<ab>/<skinId>.hskin.
    pub fn put_object(&self, skin_code: &str) -> SkinResult<(String, SkinModel)> {
        let (decoded, skin_id) = decode_skin_code(skin_code)?;
        let sub = &skin_id[..2];
        let dir = self.layout.objects.join(sub);
        fs::create_dir_all(&dir)?;
        let file = dir.join(format!("{skin_id}.hskin"));
        if !file.exists() {
            atomic_write(&file, format!("{skin_code}\n").as_bytes())?;
        }
        Ok((skin_id, decoded.model))
    }

    /// Load and fully re-validate an object by skinId (64-hex, lowercase).
    pub fn get_object(&self, skin_id: &str) -> SkinResult<Option<(String, SkinModel)>> {
        if !is_valid_skin_id(skin_id) {
            return Err(SkinError::api(codes::BAD_REQUEST, "bad skinId"));
        }
        let file = self
            .layout
            .objects
            .join(&skin_id[..2])
            .join(format!("{skin_id}.hskin"));
        let raw = match fs::read_to_string(&file) {
            Ok(raw) => raw,
            Err(_) => return Ok(None),
        };
        let code = raw.trim();
        let (decoded, verified_id) = decode_skin_code(code)?;
        if verified_id != skin_id {
            return Ok(None);
        }
        Ok(Some((code.to_string(), decoded.model)))
    }

    pub fn put_preview_png(&self, skin_id: &str, png: &[u8]) -> SkinResult<()> {
        if !is_valid_skin_id(skin_id) {
            return Err(SkinError::api(codes::BAD_REQUEST, "bad skinId"));
        }
        atomic_write(&self.layout.cache_png.join(format!("{skin_id}.png")), png)?;
        Ok(())
    }

    pub fn get_preview_png(&self, skin_id: &str) -> SkinResult<Option<Vec<u8>>> {
        if !is_valid_skin_id(skin_id) {
            return Err(SkinError::api(codes::BAD_REQUEST, "bad skinId"));
        }
        match fs::read(self.layout.cache_png.join(format!("{skin_id}.png"))) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(_) => Ok(None),
        }
    }

    /// skinIds referenced by entries or staged jobs (protected from GC).
    pub fn referenced_objects(&self, extra: &HashSet<String>) -> HashSet<String> {
        let snap = self.snapshot();
        let mut ids: HashSet<String> = extra.clone();
        for e in &snap.entries {
            ids.insert(e.skin_id.clone());
        }
        ids
    }

    /// Remove objects with no entry and no staged reference. Returns removed IDs.
    pub fn gc_objects(&self, protected: &HashSet<String>) -> SkinResult<Vec<String>> {
        let referenced = self.referenced_objects(protected);
        let mut removed = Vec::new();
        let subdirs = fs::read_dir(&self.layout.objects)?
            .flatten()
            .filter(|e| e.path().is_dir())
            .collect::<Vec<_>>();
        for sub in subdirs {
            for file in fs::read_dir(sub.path())?.flatten() {
                let name = file.file_name().to_string_lossy().to_string();
                let Some(skin_id) = name.strip_suffix(".hskin") else { continue };
                if !referenced.contains(skin_id) {
                    if fs::remove_file(file.path()).is_ok() {
                        removed.push(skin_id.to_string());
                    }
                    let _ = fs::remove_file(
                        self.layout.cache_png.join(format!("{skin_id}.png")),
                    );
                }
            }
        }
        Ok(removed)
    }

    // ------------------------------------------------------------------
    // tags
    // ------------------------------------------------------------------

    pub fn revision(&self) -> u64 {
        self.snapshot().revision
    }

    pub fn tag_tree_with_stats(&self) -> (u64, Vec<TagWithStats>) {
        let snap = self.snapshot();
        let maps = TagMaps::of(&snap.tags);
        let mut direct: HashMap<&str, HashSet<&str>> = HashMap::new();
        for e in &snap.entries {
            for id in &e.tag_ids {
                direct.entry(id.as_str()).or_default().insert(e.entry_id.as_str());
            }
        }
        let mut out = Vec::with_capacity(snap.tags.len());
        for t in &snap.tags {
            let subtree = maps.subtree_ids(&t.tag_id);
            let mut entries: HashSet<&str> = HashSet::new();
            for id in &subtree {
                if let Some(set) = direct.get(id.as_str()) {
                    entries.extend(set.iter().copied());
                }
            }
            out.push(TagWithStats {
                tag_id: t.tag_id.clone(),
                name: t.name.clone(),
                parent_id: t.parent_id.clone(),
                sort_order: t.sort_order,
                direct_count: direct.get(t.tag_id.as_str()).map(|s| s.len()).unwrap_or(0),
                subtree_count: entries.len(),
                path: maps.path_of(&t.tag_id),
            });
        }
        // Depth-first order: parent immediately followed by children.
        out.sort_by(|a, b| a.path.cmp(&b.path).then(a.sort_order.cmp(&b.sort_order)));
        (snap.revision, out)
    }

    pub fn tag_path(&self, tag_id: &str) -> Vec<String> {
        TagMaps::of(&self.snapshot().tags).path_of(tag_id)
    }

    /// Resolve tag paths (each an array of names from a root) to tagIds,
    /// creating missing nodes along the way. Returns direct leaf tagIds.
    pub fn resolve_tag_paths(&self, paths: &[Vec<String>]) -> SkinResult<(Vec<String>, u64)> {
        self.mutate(|snap| {
            let mut ids: Vec<String> = Vec::new();
            let mut changed = false;
            for raw_path in paths {
                if raw_path.is_empty() {
                    continue;
                }
                let segments: Vec<String> = raw_path
                    .iter()
                    .map(|s| normalize_name(s))
                    .filter(|s| !s.is_empty())
                    .collect();
                if segments.is_empty() {
                    continue;
                }
                let mut parent_id: Option<String> = None;
                for seg in segments.iter().take(MAX_TAG_DEPTH) {
                    let existing = snap.tags.iter().find(|t| {
                        t.parent_id == parent_id && normalize_name(&t.name) == *seg
                    });
                    match existing {
                        Some(t) => parent_id = Some(t.tag_id.clone()),
                        None => {
                            let node = TagNode {
                                tag_id: new_id(),
                                name: seg.clone(),
                                parent_id: parent_id.clone(),
                                sort_order: count_siblings(&snap.tags, &parent_id),
                            };
                            parent_id = Some(node.tag_id.clone());
                            snap.tags.push(node);
                            changed = true;
                        }
                    }
                }
                if let Some(id) = parent_id {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
            if changed {
                snap.revision += 1;
            }
            Ok((ids, snap.revision))
        })
    }

    pub fn create_tag(
        &self,
        name: &str,
        parent_id: Option<String>,
        expected_revision: Option<u64>,
    ) -> SkinResult<TagNode> {
        self.mutate(|snap| {
            if let Some(expected) = expected_revision {
                if expected != snap.revision {
                    return Err(SkinError::api(
                        codes::REVISION_MISMATCH,
                        "tree changed; reload",
                    ));
                }
            }
            let norm = normalize_name(name);
            if norm.is_empty() {
                return Err(SkinError::api(codes::TAG_NAME_CONFLICT, "name required"));
            }
            if let Some(pid) = &parent_id {
                if !snap.tags.iter().any(|t| &t.tag_id == pid) {
                    return Err(SkinError::api(codes::NOT_FOUND, "parent tag not found"));
                }
            }
            if snap
                .tags
                .iter()
                .any(|t| &t.parent_id == &parent_id && normalize_name(&t.name) == norm)
            {
                return Err(SkinError::api(
                    codes::TAG_NAME_CONFLICT,
                    "a sibling with this name already exists",
                ));
            }
            let maps = TagMaps::of(&snap.tags);
            if let Some(pid) = &parent_id {
                if maps.depth_of(pid) + 1 > MAX_TAG_DEPTH as u32 {
                    return Err(SkinError::api(
                        codes::TAG_DEPTH,
                        "maximum tag depth reached",
                    ));
                }
            }
            let node = TagNode {
                tag_id: new_id(),
                name: norm,
                parent_id,
                sort_order: count_siblings(&snap.tags, &snap.tags.last().and_then(|_| None)),
            };
            let node = TagNode { sort_order: 0, ..node };
            let node = TagNode {
                sort_order: snap
                    .tags
                    .iter()
                    .filter(|t| t.parent_id == node.parent_id)
                    .count() as i64,
                ..node
            };
            snap.tags.push(node.clone());
            snap.revision += 1;
            Ok(node)
        })
    }

    pub fn patch_tag(&self, tag_id: &str, patch: PatchTag) -> SkinResult<TagNode> {
        self.mutate(|snap| {
            if let Some(expected) = patch.expected_revision {
                if expected != snap.revision {
                    return Err(SkinError::api(
                        codes::REVISION_MISMATCH,
                        "tree changed; reload",
                    ));
                }
            }
            let idx = snap
                .tags
                .iter()
                .position(|t| t.tag_id == tag_id)
                .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "tag not found"))?;

            if let Some(pf) = &patch.parent_id {
                let new_parent = pf.as_option().cloned();
                if new_parent != snap.tags[idx].parent_id {
                    if let Some(np) = &new_parent {
                        if !snap.tags.iter().any(|t| &t.tag_id == np) {
                            return Err(SkinError::api(
                                codes::NOT_FOUND,
                                "parent tag not found",
                            ));
                        }
                        let maps = TagMaps::of(&snap.tags);
                        if maps.subtree_ids(tag_id).contains(np.as_str()) {
                            return Err(SkinError::api(
                                codes::TAG_CYCLE,
                                "cannot move a tag into itself or its descendant",
                            ));
                        }
                        let max_sub = maps.max_subtree_depth(tag_id);
                        if maps.depth_of(np) + 1 + max_sub > MAX_TAG_DEPTH as u32 {
                            return Err(SkinError::api(
                                codes::TAG_DEPTH,
                                "maximum tag depth reached",
                            ));
                        }
                    }
                    let norm =
                        normalize_name(patch.name.as_ref().unwrap_or(&snap.tags[idx].name));
                    let dup = snap.tags.iter().any(|t| {
                        &t.tag_id != tag_id
                            && t.parent_id.as_deref() == new_parent.as_deref()
                            && normalize_name(&t.name) == norm
                    });
                    if dup {
                        return Err(SkinError::api(
                            codes::TAG_NAME_CONFLICT,
                            "a sibling with this name already exists",
                        ));
                    }
                    snap.tags[idx].parent_id = new_parent.clone();
                    snap.tags[idx].sort_order =
                        count_siblings_excluding(&snap.tags, &new_parent, tag_id);
                }
            }

            if let Some(name) = &patch.name {
                let norm = normalize_name(name);
                if norm.is_empty() {
                    return Err(SkinError::api(codes::TAG_NAME_CONFLICT, "name required"));
                }
                let dup = snap.tags.iter().any(|t| {
                    &t.tag_id != tag_id
                        && t.parent_id == snap.tags[idx].parent_id
                        && normalize_name(&t.name) == norm
                });
                if dup {
                    return Err(SkinError::api(
                        codes::TAG_NAME_CONFLICT,
                        "a sibling with this name already exists",
                    ));
                }
                snap.tags[idx].name = norm;
            }

            if let Some(target) = patch.sort_order {
                reorder_siblings_tag(snap, &snap.tags[idx].parent_id.clone(), tag_id, target);
            }
            if patch.sort_siblings_by_name {
                sort_siblings_by_name_tag(snap, &snap.tags[idx].parent_id.clone());
            }

            snap.revision += 1;
            Ok(snap.tags[idx].clone())
        })
    }

    /// Delete a tag. branch=false refuses when children exist; branch=true
    /// removes the node and all descendants. Entries keep remaining tagIds.
    pub fn delete_tag(
        &self,
        tag_id: &str,
        branch: bool,
        expected_revision: Option<u64>,
    ) -> SkinResult<(Vec<String>, usize)> {
        self.mutate(|snap| {
            if let Some(expected) = expected_revision {
                if expected != snap.revision {
                    return Err(SkinError::api(
                        codes::REVISION_MISMATCH,
                        "tree changed; reload",
                    ));
                }
            }
            if !snap.tags.iter().any(|t| t.tag_id == tag_id) {
                return Err(SkinError::api(codes::NOT_FOUND, "tag not found"));
            }
            let has_children = snap.tags.iter().any(|t| t.parent_id.as_deref() == Some(tag_id));
            if has_children && !branch {
                return Err(SkinError::api(
                    codes::TAG_HAS_CHILDREN,
                    "tag has children; move them first or delete the whole branch",
                ));
            }
            let maps = TagMaps::of(&snap.tags);
            let removed: HashSet<String> = if branch {
                maps.subtree_ids(tag_id)
            } else {
                HashSet::from([tag_id.to_string()])
            };
            let mut affected = 0usize;
            for e in &mut snap.entries {
                let before = e.tag_ids.len();
                e.tag_ids.retain(|id| !removed.contains(id));
                if e.tag_ids.len() != before {
                    affected += 1;
                    e.revision += 1;
                    e.updated_at = now_iso();
                }
            }
            snap.tags.retain(|t| !removed.contains(&t.tag_id));
            snap.revision += 1;
            Ok((removed.into_iter().collect(), affected))
        })
    }

    // ------------------------------------------------------------------
    // folders
    // ------------------------------------------------------------------

    pub fn folder_tree_with_stats(&self) -> (u64, Vec<FolderWithStats>) {
        let snap = self.snapshot();
        let maps = FolderMaps::of(&snap.folders);
        let mut direct: HashMap<&str, usize> = HashMap::new();
        for e in &snap.entries {
            if let Some(fid) = &e.folder_id {
                *direct.entry(fid.as_str()).or_insert(0) += 1;
            }
        }
        let mut out = Vec::with_capacity(snap.folders.len());
        for f in &snap.folders {
            let subtree = maps.subtree_ids(&f.folder_id);
            let subtree_count: usize = subtree
                .iter()
                .map(|id| direct.get(id.as_str()).copied().unwrap_or(0))
                .sum();
            out.push(FolderWithStats {
                folder_id: f.folder_id.clone(),
                name: f.name.clone(),
                parent_id: f.parent_id.clone(),
                sort_order: f.sort_order,
                direct_count: direct.get(f.folder_id.as_str()).copied().unwrap_or(0),
                subtree_count,
                path: maps.path_of(&f.folder_id),
            });
        }
        out.sort_by(|a, b| a.path.cmp(&b.path).then(a.sort_order.cmp(&b.sort_order)));
        (snap.revision, out)
    }

    pub fn create_folder(&self, name: &str, parent_id: Option<String>) -> SkinResult<FolderNode> {
        self.mutate(|snap| {
            let norm = normalize_name(name);
            if norm.is_empty() {
                return Err(SkinError::api(codes::FOLDER_NAME_CONFLICT, "name required"));
            }
            if let Some(pid) = &parent_id {
                if !snap.folders.iter().any(|f| &f.folder_id == pid) {
                    return Err(SkinError::api(
                        codes::NOT_FOUND,
                        "parent folder not found",
                    ));
                }
            }
            if snap
                .folders
                .iter()
                .any(|f| &f.parent_id == &parent_id && normalize_name(&f.name) == norm)
            {
                return Err(SkinError::api(
                    codes::FOLDER_NAME_CONFLICT,
                    "a sibling folder with this name already exists",
                ));
            }
            let maps = FolderMaps::of(&snap.folders);
            if let Some(pid) = &parent_id {
                if maps.depth_of(pid) + 1 > MAX_FOLDER_DEPTH as u32 {
                    return Err(SkinError::api(
                        codes::FOLDER_DEPTH,
                        "maximum folder depth reached",
                    ));
                }
            }
            let sort_order = snap
                .folders
                .iter()
                .filter(|f| f.parent_id == parent_id)
                .count() as i64;
            let node = FolderNode {
                folder_id: new_id(),
                name: norm,
                parent_id,
                sort_order,
            };
            snap.folders.push(node.clone());
            snap.revision += 1;
            Ok(node)
        })
    }

    pub fn patch_folder(&self, folder_id: &str, patch: PatchFolder) -> SkinResult<FolderNode> {
        self.mutate(|snap| {
            let idx = snap
                .folders
                .iter()
                .position(|f| f.folder_id == folder_id)
                .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "folder not found"))?;

            if let Some(pf) = &patch.parent_id {
                let new_parent = pf.as_option().cloned();
                if new_parent != snap.folders[idx].parent_id {
                    if let Some(np) = &new_parent {
                        if !snap.folders.iter().any(|f| &f.folder_id == np) {
                            return Err(SkinError::api(
                                codes::NOT_FOUND,
                                "parent folder not found",
                            ));
                        }
                        let maps = FolderMaps::of(&snap.folders);
                        if maps.subtree_ids(folder_id).contains(np.as_str()) {
                            return Err(SkinError::api(
                                codes::FOLDER_CYCLE,
                                "cannot move a folder into itself or its descendant",
                            ));
                        }
                        let max_sub = maps.max_subtree_depth(folder_id);
                        if maps.depth_of(np) + 1 + max_sub > MAX_FOLDER_DEPTH as u32 {
                            return Err(SkinError::api(
                                codes::FOLDER_DEPTH,
                                "maximum folder depth reached",
                            ));
                        }
                    }
                    let norm =
                        normalize_name(patch.name.as_ref().unwrap_or(&snap.folders[idx].name));
                    let dup = snap.folders.iter().any(|f| {
                        &f.folder_id != folder_id
                            && f.parent_id.as_deref() == new_parent.as_deref()
                            && normalize_name(&f.name) == norm
                    });
                    if dup {
                        return Err(SkinError::api(
                            codes::FOLDER_NAME_CONFLICT,
                            "a sibling folder with this name already exists",
                        ));
                    }
                    snap.folders[idx].parent_id = new_parent.clone();
                    snap.folders[idx].sort_order = count_folder_siblings_excluding(
                        &snap.folders,
                        &new_parent,
                        folder_id,
                    );
                }
            }

            if let Some(name) = &patch.name {
                let norm = normalize_name(name);
                if norm.is_empty() {
                    return Err(SkinError::api(codes::FOLDER_NAME_CONFLICT, "name required"));
                }
                let dup = snap.folders.iter().any(|f| {
                    &f.folder_id != folder_id
                        && f.parent_id == snap.folders[idx].parent_id
                        && normalize_name(&f.name) == norm
                });
                if dup {
                    return Err(SkinError::api(
                        codes::FOLDER_NAME_CONFLICT,
                        "a sibling folder with this name already exists",
                    ));
                }
                snap.folders[idx].name = norm;
            }

            if let Some(target) = patch.sort_order {
                reorder_siblings_folder(snap, &snap.folders[idx].parent_id.clone(), folder_id, target);
            }
            if patch.sort_siblings_by_name {
                sort_siblings_by_name_folder(snap, &snap.folders[idx].parent_id.clone());
            }

            snap.revision += 1;
            Ok(snap.folders[idx].clone())
        })
    }

    /// Only empty folders (no entries, no sub-folders) can be removed.
    pub fn delete_folder(&self, folder_id: &str) -> SkinResult<()> {
        self.mutate(|snap| {
            if !snap.folders.iter().any(|f| f.folder_id == folder_id) {
                return Err(SkinError::api(codes::NOT_FOUND, "folder not found"));
            }
            if snap
                .folders
                .iter()
                .any(|f| f.parent_id.as_deref() == Some(folder_id))
            {
                return Err(SkinError::api(
                    codes::FOLDER_NOT_EMPTY,
                    "folder has sub-folders; move them first",
                ));
            }
            if snap.entries.iter().any(|e| e.folder_id.as_deref() == Some(folder_id)) {
                return Err(SkinError::api(
                    codes::FOLDER_NOT_EMPTY,
                    "folder still contains skins; move them first",
                ));
            }
            snap.folders.retain(|f| f.folder_id != folder_id);
            snap.revision += 1;
            Ok(())
        })
    }

    // ------------------------------------------------------------------
    // entries
    // ------------------------------------------------------------------

    pub fn list_entries(&self, q: &LibraryQuery) -> LibraryPage {
        let snap = self.snapshot();
        let maps = TagMaps::of(&snap.tags);
        let fmaps = FolderMaps::of(&snap.folders);
        let mut out: Vec<&LibraryEntry> = snap.entries.iter().collect();

        // Scope filter
        match q.scope {
            Some(EntryScope::Unfiled) => {
                out.retain(|e| e.folder_id.is_none());
            }
            Some(EntryScope::Folder) => {
                if let Some(fid) = &q.folder_id {
                    if q.include_subfolders {
                        let ids = fmaps.subtree_ids(fid);
                        out.retain(|e| {
                            e.folder_id
                                .as_ref()
                                .map(|f| ids.contains(f.as_str()))
                                .unwrap_or(false)
                        });
                    } else {
                        out.retain(|e| e.folder_id.as_deref() == Some(fid.as_str()));
                    }
                }
            }
            _ => {
                // All or legacy folderId behavior
                if let Some(fid) = &q.folder_id {
                    if q.include_subfolders {
                        let ids = fmaps.subtree_ids(fid);
                        out.retain(|e| {
                            e.folder_id
                                .as_ref()
                                .map(|f| ids.contains(f.as_str()))
                                .unwrap_or(false)
                        });
                    } else {
                        out.retain(|e| e.folder_id.as_deref() == Some(fid.as_str()));
                    }
                }
            }
        }

        if let Some(fav) = q.favorite {
            out.retain(|e| e.favorite == fav);
        }
        if let Some(active) = q.active {
            out.retain(|e| e.active == active);
        }
        if !q.models.is_empty() {
            out.retain(|e| q.models.contains(&e.model));
        }
        if !q.include_license_names.is_empty() {
            out.retain(|e| {
                e.license
                    .name
                    .as_ref()
                    .map(|n| q.include_license_names.contains(n))
                    .unwrap_or(false)
            });
        }
        if !q.exclude_license_names.is_empty() {
            out.retain(|e| {
                e.license
                    .name
                    .as_ref()
                    .map(|n| !q.exclude_license_names.contains(n))
                    .unwrap_or(true)
            });
        }
        if let Some(unspec) = q.license_unspecified {
            out.retain(|e| {
                let is_unspec = e.license.status != LicenseStatus::Declared
                    || e.license.name.is_none();
                is_unspec == unspec
            });
        }
        if let Some(author) = &q.author {
            let needle = author.to_lowercase();
            out.retain(|e| {
                e.provenance
                    .author
                    .as_ref()
                    .map(|a| a.to_lowercase().contains(&needle))
                    .unwrap_or(false)
            });
        }
        if let Some(from) = &q.created_from {
            out.retain(|e| e.created_at.as_str() >= from.as_str());
        }
        if let Some(to) = &q.created_to {
            out.retain(|e| e.created_at.as_str() <= to.as_str());
        }
        if q.untagged {
            out.retain(|e| e.tag_ids.is_empty());
        } else if !q.tag_ids.is_empty() {
            let scope = q.tag_scope.unwrap_or(TagScope::Subtree);
            let m = q.tag_match.unwrap_or(TagMatch::Any);
            let id_sets: Vec<HashSet<String>> = q
                .tag_ids
                .iter()
                .map(|id| match scope {
                    TagScope::Subtree => maps.subtree_ids(id),
                    TagScope::Direct => HashSet::from([id.clone()]),
                })
                .collect();
            out.retain(|e| {
                let has = |set: &HashSet<String>| e.tag_ids.iter().any(|t| set.contains(t));
                match m {
                    TagMatch::All => id_sets.iter().all(has),
                    TagMatch::Any => id_sets.iter().any(has),
                }
            });
        }
        if !q.exclude_tag_ids.is_empty() {
            let scope = q.tag_scope.unwrap_or(TagScope::Subtree);
            let exclude_sets: Vec<HashSet<String>> = q
                .exclude_tag_ids
                .iter()
                .map(|id| match scope {
                    TagScope::Subtree => maps.subtree_ids(id),
                    TagScope::Direct => HashSet::from([id.clone()]),
                })
                .collect();
            out.retain(|e| {
                !exclude_sets.iter().any(|set| e.tag_ids.iter().any(|t| set.contains(t)))
            });
        }
        if let Some(search) = &q.search {
            if !search.is_empty() {
                let needle = search.to_lowercase();
                let mut path_cache: HashMap<String, String> = HashMap::new();
                out.retain(|e| {
                    if e.name.to_lowercase().contains(&needle) {
                        return true;
                    }
                    if e.provenance.author.as_ref().map(|a| a.to_lowercase().contains(&needle)).unwrap_or(false) {
                        return true;
                    }
                    if e.provenance.source_name.as_ref().map(|s| s.to_lowercase().contains(&needle)).unwrap_or(false) {
                        return true;
                    }
                    if e.note.to_lowercase().contains(&needle) {
                        return true;
                    }
                    if e.entry_id.to_lowercase().contains(&needle) {
                        return true;
                    }
                    if e.skin_id.to_lowercase().contains(&needle) {
                        return true;
                    }
                    e.tag_ids.iter().any(|id| {
                        let p = path_cache
                            .entry(id.clone())
                            .or_insert_with(|| maps.path_of(id).join("/").to_lowercase());
                        p.contains(&needle)
                    })
                });
            }
        }

        // Stable sorting
        let sort_by = q.sort_by.unwrap_or(EntrySortBy::CreatedAt);
        let sort_dir = q.sort_direction.unwrap_or(SortDirection::Desc);
        out.sort_by(|a, b| {
            let ord = match sort_by {
                EntrySortBy::Name => a.name.cmp(&b.name),
                EntrySortBy::CreatedAt => a.created_at.cmp(&b.created_at),
                EntrySortBy::UpdatedAt => a.updated_at.cmp(&b.updated_at),
                EntrySortBy::Author => {
                    let aa = a.provenance.author.as_deref().unwrap_or("");
                    let bb = b.provenance.author.as_deref().unwrap_or("");
                    aa.cmp(bb)
                }
            };
            let ord = ord.then(a.entry_id.cmp(&b.entry_id));
            match sort_dir {
                SortDirection::Asc => ord,
                SortDirection::Desc => ord.reverse(),
            }
        });

        let total = out.len();
        let page = q.page.unwrap_or(1).max(1);
        let page_size = q.page_size.unwrap_or(48).clamp(1, 200);
        let start = ((page as usize - 1) * page_size as usize).min(total);
        let end = (start + page_size as usize).min(total);
        LibraryPage {
            entries: out[start..end].iter().map(|e| (*e).clone()).collect(),
            total,
            page,
            page_size: page_size as u32,
            revision: snap.revision,
        }
    }

    pub fn get_entry(&self, entry_id: &str) -> Option<LibraryEntry> {
        self.snapshot()
            .entries
            .iter()
            .find(|e| e.entry_id == entry_id)
            .cloned()
    }

    pub fn entries_using(&self, skin_id: &str) -> Vec<LibraryEntry> {
        self.snapshot()
            .entries
            .iter()
            .filter(|e| e.skin_id == skin_id)
            .cloned()
            .collect()
    }

    /// List entries that are active and ready for use (e.g. export manifest).
    pub fn list_usable_entries(&self) -> Vec<LibraryEntry> {
        self.snapshot()
            .entries
            .iter()
            .filter(|e| e.active)
            .cloned()
            .collect()
    }

    pub fn add_entry(&self, input: AddEntryInput) -> SkinResult<LibraryEntry> {
        self.mutate(|snap| {
            let now = now_iso();
            let tag_ids_set = snap.tag_ids();
            let folder_ids_set = snap.folder_ids();
            let mut tag_ids: Vec<String> = Vec::new();
            for id in input.tag_ids {
                if tag_ids_set.contains(&id) && !tag_ids.contains(&id) {
                    tag_ids.push(id);
                }
            }
            let folder_id = input.folder_id.filter(|f| folder_ids_set.contains(f));
            let entry = LibraryEntry {
                entry_id: new_id(),
                skin_id: input.skin_id,
                name: input.name,
                active: input.active,
                tag_ids,
                folder_id,
                favorite: input.favorite,
                model: input.model,
                source: input.source,
                provenance: input.provenance,
                license: input.license,
                note: input.note,
                created_at: now.clone(),
                updated_at: now,
                revision: 1,
            };
            snap.entries.push(entry.clone());
            snap.revision += 1;
            Ok(entry)
        })
    }

    pub fn patch_entry(
        &self,
        entry_id: &str,
        expected_revision: u64,
        patch: PatchEntry,
    ) -> SkinResult<LibraryEntry> {
        self.mutate(|snap| {
            let idx = snap
                .entries
                .iter()
                .position(|e| e.entry_id == entry_id)
                .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "entry not found"))?;
            if snap.entries[idx].revision != expected_revision {
                return Err(SkinError::api(
                    codes::REVISION_MISMATCH,
                    "entry was modified; reload and retry",
                ));
            }
            let tag_ids_set = snap.tag_ids();
            let folder_ids_set = snap.folder_ids();
            if let Some(name) = &patch.name {
                snap.entries[idx].name = name.clone();
            }
            if let Some(tag_ids) = &patch.tag_ids {
                let mut merged: Vec<String> = Vec::new();
                for id in tag_ids {
                    if tag_ids_set.contains(id) && !merged.contains(id) {
                        merged.push(id.clone());
                    }
                }
                snap.entries[idx].tag_ids = merged;
            }
            if let Some(add) = &patch.add_tag_ids {
                for id in add {
                    if tag_ids_set.contains(id) && !snap.entries[idx].tag_ids.contains(id) {
                        snap.entries[idx].tag_ids.push(id.clone());
                    }
                }
            }
            if let Some(remove) = &patch.remove_tag_ids {
                snap.entries[idx].tag_ids.retain(|id| !remove.contains(id));
            }
            if let Some(fav) = patch.favorite {
                snap.entries[idx].favorite = fav;
            }
            if let Some(pf) = &patch.folder_id {
                snap.entries[idx].folder_id =
                    pf.as_option().filter(|f| folder_ids_set.contains(*f)).cloned();
            }
            if let Some(active) = patch.active {
                snap.entries[idx].active = active;
            }
            if let Some(license) = &patch.license {
                snap.entries[idx].license = license.clone();
            }
            if let Some(provenance) = &patch.provenance {
                snap.entries[idx].provenance = provenance.clone();
            }
            if let Some(note) = &patch.note {
                snap.entries[idx].note = note.clone();
            }
            snap.entries[idx].revision += 1;
            snap.entries[idx].updated_at = now_iso();
            snap.revision += 1;
            Ok(snap.entries[idx].clone())
        })
    }

    /// Batch add/remove of direct tags and/or move to folder; all-or-nothing.
    pub fn batch_patch_entries(&self, batch: BatchPatch) -> SkinResult<(usize, u64)> {
        self.mutate(|snap| {
            let mut targets = Vec::with_capacity(batch.entry_ids.len());
            for (i, id) in batch.entry_ids.iter().enumerate() {
                let idx = snap
                    .entries
                    .iter()
                    .position(|e| e.entry_id == *id)
                    .ok_or_else(|| {
                        SkinError::api(codes::NOT_FOUND, "one or more entries not found")
                    })?;
                if let Some(expected) = &batch.expected_revisions {
                    if let Some(exp) = expected.get(i) {
                        if snap.entries[idx].revision != *exp {
                            return Err(SkinError::api(
                                codes::REVISION_MISMATCH,
                                format!("entry {} was modified; reload and retry", id),
                            ));
                        }
                    }
                }
                targets.push(idx);
            }
            let tag_ids_set = snap.tag_ids();
            let folder_ids_set = snap.folder_ids();
            let add: Vec<String> = batch
                .add_tag_ids
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .filter(|id| tag_ids_set.contains(*id))
                .cloned()
                .collect();
            let remove: HashSet<String> = batch
                .remove_tag_ids
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .cloned()
                .collect();
            let now = now_iso();
            let mut updated = 0usize;
            for idx in targets {
                let e = &mut snap.entries[idx];
                if !add.is_empty() {
                    for id in &add {
                        if !e.tag_ids.contains(id) {
                            e.tag_ids.push(id.clone());
                        }
                    }
                }
                if !remove.is_empty() {
                    e.tag_ids.retain(|id| !remove.contains(id));
                }
                if let Some(pf) = &batch.folder_id {
                    e.folder_id = pf.as_option().filter(|f| folder_ids_set.contains(*f)).cloned();
                }
                if let Some(active) = batch.active {
                    e.active = active;
                }
                e.revision += 1;
                e.updated_at = now.clone();
                updated += 1;
            }
            snap.revision += 1;
            Ok((updated, snap.revision))
        })
    }

    pub fn remove_entry(&self, entry_id: &str) -> SkinResult<bool> {
        self.mutate(|snap| {
            let before = snap.entries.len();
            snap.entries.retain(|e| e.entry_id != entry_id);
            if snap.entries.len() == before {
                return Ok(false);
            }
            snap.revision += 1;
            Ok(true)
        })
    }
}

#[derive(Debug)]
pub struct AddEntryInput {
    pub skin_id: String,
    pub name: String,
    pub active: bool,
    pub tag_ids: Vec<String>,
    pub folder_id: Option<String>,
    pub favorite: bool,
    pub model: SkinModel,
    pub source: EntrySource,
    pub provenance: Provenance,
    pub license: LicenseInfo,
    pub note: String,
}

pub fn is_valid_skin_id(skin_id: &str) -> bool {
    skin_id.len() == 64
        && skin_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryFileV4Owned {
    #[serde(default = "default_revision")]
    revision: u64,
    #[serde(default)]
    tags: Vec<TagNode>,
    #[serde(default)]
    folders: Vec<FolderNode>,
    #[serde(default)]
    entries: Vec<LibraryEntry>,
}

fn default_revision() -> u64 {
    1
}

/// Drop dangling references after load (files are user-readable).
fn sanitize(mut snap: Snapshot) -> Snapshot {
    let tag_ids: HashSet<String> = snap.tags.iter().map(|t| t.tag_id.clone()).collect();
    for t in &mut snap.tags {
        if let Some(pid) = &t.parent_id {
            if !tag_ids.contains(pid) {
                t.parent_id = None;
            }
        }
    }
    let folder_ids: HashSet<String> = snap.folders.iter().map(|f| f.folder_id.clone()).collect();
    for f in &mut snap.folders {
        if let Some(pid) = &f.parent_id {
            if !folder_ids.contains(pid) {
                f.parent_id = None;
            }
        }
    }
    for e in &mut snap.entries {
        e.tag_ids.retain(|id| tag_ids.contains(id));
        if let Some(fid) = &e.folder_id {
            if !folder_ids.contains(fid) {
                e.folder_id = None;
            }
        }
    }
    snap
}

struct TagMaps {
    by_id: HashMap<String, TagNode>,
    children_of: HashMap<Option<String>, Vec<String>>,
}

impl TagMaps {
    fn of(tags: &[TagNode]) -> Self {
        let mut by_id = HashMap::new();
        let mut children_of: HashMap<Option<String>, Vec<String>> = HashMap::new();
        for t in tags {
            by_id.insert(t.tag_id.clone(), t.clone());
            children_of.entry(t.parent_id.clone()).or_default().push(t.tag_id.clone());
        }
        for (pid, list) in &mut children_of {
            list.sort_by_key(|id| by_id[id].sort_order);
            let _ = pid;
        }
        Self { by_id, children_of }
    }

    fn path_of(&self, tag_id: &str) -> Vec<String> {
        let mut path = Vec::new();
        let mut cur = self.by_id.get(tag_id).cloned();
        let mut guard = 0;
        while let Some(node) = cur {
            if guard > MAX_TAG_DEPTH + 2 {
                break;
            }
            guard += 1;
            path.insert(0, node.name.clone());
            cur = node.parent_id.and_then(|p| self.by_id.get(&p).cloned());
        }
        path
    }

    fn subtree_ids(&self, tag_id: &str) -> HashSet<String> {
        let mut out = HashSet::new();
        let mut stack = vec![tag_id.to_string()];
        while let Some(id) = stack.pop() {
            if !out.insert(id.clone()) {
                continue;
            }
            if let Some(children) = self.children_of.get(&Some(id.clone())) {
                stack.extend(children.iter().cloned());
            }
        }
        out
    }

    fn depth_of(&self, tag_id: &str) -> u32 {
        let mut depth = 1;
        let mut cur = self.by_id.get(tag_id).cloned();
        let mut guard = 0;
        while let Some(node) = cur {
            if guard > MAX_TAG_DEPTH + 2 {
                break;
            }
            guard += 1;
            match node.parent_id {
                Some(pid) => {
                    depth += 1;
                    cur = self.by_id.get(&pid).cloned();
                }
                None => break,
            }
        }
        depth
    }

    fn max_subtree_depth(&self, tag_id: &str) -> u32 {
        fn walk(maps: &TagMaps, id: &str, d: u32) -> u32 {
            let mut max = d;
            if let Some(children) = maps.children_of.get(&Some(id.to_string())) {
                for c in children {
                    max = max.max(walk(maps, c, d + 1));
                }
            }
            max
        }
        walk(self, tag_id, 0)
    }
}

struct FolderMaps {
    by_id: HashMap<String, FolderNode>,
    children_of: HashMap<Option<String>, Vec<String>>,
}

impl FolderMaps {
    fn of(folders: &[FolderNode]) -> Self {
        let mut by_id = HashMap::new();
        let mut children_of: HashMap<Option<String>, Vec<String>> = HashMap::new();
        for f in folders {
            by_id.insert(f.folder_id.clone(), f.clone());
            children_of.entry(f.parent_id.clone()).or_default().push(f.folder_id.clone());
        }
        for list in children_of.values_mut() {
            list.sort_by_key(|id| by_id[id].sort_order);
        }
        Self { by_id, children_of }
    }

    fn path_of(&self, folder_id: &str) -> Vec<String> {
        let mut path = Vec::new();
        let mut cur = self.by_id.get(folder_id).cloned();
        let mut guard = 0;
        while let Some(node) = cur {
            if guard > MAX_FOLDER_DEPTH + 2 {
                break;
            }
            guard += 1;
            path.insert(0, node.name.clone());
            cur = node.parent_id.and_then(|p| self.by_id.get(&p).cloned());
        }
        path
    }

    fn subtree_ids(&self, folder_id: &str) -> HashSet<String> {
        let mut out = HashSet::new();
        let mut stack = vec![folder_id.to_string()];
        while let Some(id) = stack.pop() {
            if !out.insert(id.clone()) {
                continue;
            }
            if let Some(children) = self.children_of.get(&Some(id.clone())) {
                stack.extend(children.iter().cloned());
            }
        }
        out
    }

    fn depth_of(&self, folder_id: &str) -> u32 {
        let mut depth = 1;
        let mut cur = self.by_id.get(folder_id).cloned();
        let mut guard = 0;
        while let Some(node) = cur {
            if guard > MAX_FOLDER_DEPTH + 2 {
                break;
            }
            guard += 1;
            match node.parent_id {
                Some(pid) => {
                    depth += 1;
                    cur = self.by_id.get(&pid).cloned();
                }
                None => break,
            }
        }
        depth
    }

    fn max_subtree_depth(&self, folder_id: &str) -> u32 {
        fn walk(maps: &FolderMaps, id: &str, d: u32) -> u32 {
            let mut max = d;
            if let Some(children) = maps.children_of.get(&Some(id.to_string())) {
                for c in children {
                    max = max.max(walk(maps, c, d + 1));
                }
            }
            max
        }
        walk(self, folder_id, 0)
    }
}

fn count_siblings(tags: &[TagNode], parent_id: &Option<String>) -> i64 {
    tags.iter().filter(|t| &t.parent_id == parent_id).count() as i64
}

fn count_siblings_excluding(tags: &[TagNode], parent_id: &Option<String>, exclude: &str) -> i64 {
    tags.iter()
        .filter(|t| &t.parent_id == parent_id && t.tag_id != exclude)
        .count() as i64
}

fn count_folder_siblings_excluding(
    folders: &[FolderNode],
    parent_id: &Option<String>,
    exclude: &str,
) -> i64 {
    folders
        .iter()
        .filter(|f| &f.parent_id == parent_id && f.folder_id != exclude)
        .count() as i64
}

fn reorder_siblings_tag(snap: &mut Snapshot, parent_id: &Option<String>, tag_id: &str, target: i64) {
    let mut siblings: Vec<TagNode> = snap
        .tags
        .iter()
        .filter(|t| &t.parent_id == parent_id)
        .cloned()
        .collect();
    siblings.sort_by_key(|t| t.sort_order);
    if let Some(from) = siblings.iter().position(|t| t.tag_id == tag_id) {
        let to = (target.max(0) as usize).min(siblings.len() - 1);
        let item = siblings.remove(from);
        siblings.insert(to, item);
        for (i, t) in siblings.iter().enumerate() {
            if let Some(node) = snap.tags.iter_mut().find(|x| x.tag_id == t.tag_id) {
                node.sort_order = i as i64;
            }
        }
    }
}

fn sort_siblings_by_name_tag(snap: &mut Snapshot, parent_id: &Option<String>) {
    let mut siblings: Vec<TagNode> = snap
        .tags
        .iter()
        .filter(|t| &t.parent_id == parent_id)
        .cloned()
        .collect();
    siblings.sort_by(|a, b| a.name.cmp(&b.name));
    for (i, t) in siblings.iter().enumerate() {
        if let Some(node) = snap.tags.iter_mut().find(|x| x.tag_id == t.tag_id) {
            node.sort_order = i as i64;
        }
    }
}

fn reorder_siblings_folder(
    snap: &mut Snapshot,
    parent_id: &Option<String>,
    folder_id: &str,
    target: i64,
) {
    let mut siblings: Vec<FolderNode> = snap
        .folders
        .iter()
        .filter(|f| &f.parent_id == parent_id)
        .cloned()
        .collect();
    siblings.sort_by_key(|f| f.sort_order);
    if let Some(from) = siblings.iter().position(|f| f.folder_id == folder_id) {
        let to = (target.max(0) as usize).min(siblings.len() - 1);
        let item = siblings.remove(from);
        siblings.insert(to, item);
        for (i, f) in siblings.iter().enumerate() {
            if let Some(node) = snap.folders.iter_mut().find(|x| x.folder_id == f.folder_id) {
                node.sort_order = i as i64;
            }
        }
    }
}

fn sort_siblings_by_name_folder(snap: &mut Snapshot, parent_id: &Option<String>) {
    let mut siblings: Vec<FolderNode> = snap
        .folders
        .iter()
        .filter(|f| &f.parent_id == parent_id)
        .cloned()
        .collect();
    siblings.sort_by(|a, b| a.name.cmp(&b.name));
    for (i, f) in siblings.iter().enumerate() {
        if let Some(node) = snap.folders.iter_mut().find(|x| x.folder_id == f.folder_id) {
            node.sort_order = i as i64;
        }
    }
}
