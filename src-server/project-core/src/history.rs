//! Immutable project revisions. Content is deduplicated by SHA-256 and gzip encoded.
//! The file commit journal publishes a revision only after its durable decision.
use super::*;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use std::{
    cell::RefCell,
    collections::BTreeSet,
    io::{Read, Seek, SeekFrom},
};

const MAX_METADATA: usize = 32 * 1024 * 1024;
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryActor {
    pub subject_id: String,
    pub name: String,
    pub client_name: String,
    pub session_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryObject {
    pub kind: String,
    pub hash: Option<String>,
    #[ts(type = "number")]
    pub size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryChange {
    pub path: String,
    pub before: Option<HistoryObject>,
    pub after: Option<HistoryObject>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
pub struct HistoryMove {
    pub from: String,
    pub to: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    #[ts(type = "number")]
    pub sequence: u64,
    pub project_id: String,
    #[ts(type = "number")]
    pub time: u64,
    pub kind: String,
    pub transaction_id: Option<String>,
    pub actor: Option<HistoryActor>,
    pub changes: Vec<HistoryChange>,
    pub moves: Vec<HistoryMove>,
    #[ts(type = "number")]
    pub group_id: u64,
    pub label: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub entries: Vec<HistoryEntry>,
    #[ts(type = "number | null")]
    pub next_before: Option<u64>,
    #[ts(type = "number")]
    pub head: u64,
    pub project_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTree {
    #[ts(type = "number")]
    pub sequence: u64,
    pub scope_path: Option<String>,
    pub entries: Vec<ProjectFile>,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryContent {
    #[ts(type = "number")]
    pub sequence: u64,
    pub path: String,
    pub content: String,
    pub version: String,
    #[ts(type = "number")]
    pub size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStats {
    #[ts(type = "number")]
    pub head: u64,
    #[ts(type = "number")]
    pub revisions: u64,
    #[ts(type = "number")]
    pub objects: u64,
    #[ts(type = "number")]
    pub stored_bytes: u64,
    #[ts(type = "number")]
    pub raw_bytes: u64,
    #[ts(type = "number")]
    pub named_versions: u64,
}

type Manifest = BTreeMap<String, HistoryObject>;
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HistoryRevision {
    entry: HistoryEntry,
    manifest: Manifest,
    group_started_at: u64,
    isolated: bool,
}
pub(super) struct HistoryState {
    project_id: String,
    latest: Option<HistoryRevision>,
}
pub(super) struct HistoryContext {
    pub actor: Option<HistoryActor>,
    pub now: u64,
    pub kind: String,
    pub transaction_id: Option<String>,
    pub isolated: bool,
    pub moves: Vec<HistoryMove>,
}
pub(super) fn isolated_operation(change: &FileChange) -> bool {
    if matches!(change.op.as_str(), "remove" | "history-restore") {
        return true;
    }
    if change.op != "skin-library-command" {
        return false;
    }
    change
        .content
        .as_deref()
        .and_then(|content| STANDARD.decode(content).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value["command"].as_str().map(str::to_owned))
        .is_some_and(|command| {
            command.starts_with("delete-")
                || matches!(command.as_str(), "batch-patch" | "rename-tag")
        })
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn manifest(tree: &Tree) -> Manifest {
    tree.iter()
        .map(|(path, value)| {
            (
                path.clone(),
                HistoryObject {
                    kind: if value.is_some() { "file" } else { "directory" }.into(),
                    hash: value.as_ref().map(|bytes| hex_digest(bytes)),
                    size: value.as_ref().map_or(0, |bytes| bytes.len() as u64),
                },
            )
        })
        .collect()
}
fn validate_manifest(value: &Manifest) -> Result<()> {
    require(value.len() <= 16384, "storage", "历史文件清单过大")?;
    let mut total = 0u64;
    let mut names = BTreeSet::new();
    for (path, object) in value {
        path_ok(path)?;
        require(
            names.insert(path.to_lowercase()),
            "storage",
            "历史路径大小写冲突",
        )?;
        require(
            match object.kind.as_str() {
                "directory" => object.hash.is_none() && object.size == 0,
                "file" => {
                    object.hash.as_deref().is_some_and(valid_hash) && object.size <= MAX_FILE as u64
                }
                _ => false,
            },
            "storage",
            "历史内容引用无效",
        )?;
        total = total.saturating_add(object.size);
    }
    require(total <= MAX_TREE as u64, "storage", "历史工程超过容量限制")
}
fn bounded_file(path: &Path, max: usize) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    require(
        meta.is_file() && !reparse(&meta) && meta.len() <= (max + 1024 * 1024) as u64,
        "storage",
        "历史文件无效、过大或为链接",
    )?;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take((max + 1) as u64)
        .read_to_end(&mut bytes)?;
    require(bytes.len() <= max, "storage", "历史文件超过读取上限")?;
    Ok(bytes)
}
fn decode_gzip(path: &Path, max: usize) -> Result<Vec<u8>> {
    let compressed = bounded_file(path, max + 1024 * 1024)?;
    let mut decoded = Vec::new();
    GzDecoder::new(compressed.as_slice())
        .take((max + 1) as u64)
        .read_to_end(&mut decoded)?;
    require(decoded.len() <= max, "storage", "历史解压内容超过读取上限")?;
    Ok(decoded)
}
fn gzip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(bytes)?;
    Ok(encoder.finish()?)
}

fn scope_matches(revision: &HistoryRevision, path: &str, previous_path: &str) -> bool {
    if revision.entry.changes.iter().any(|change| {
        nested(path, &change.path)
            || nested(&change.path, path)
            || nested(previous_path, &change.path)
            || nested(&change.path, previous_path)
    }) {
        return true;
    }
    if !path.starts_with("src/") && !previous_path.starts_with("src/") {
        return false;
    }
    // Ownership is determined by source paths and file/directory shape. No contents
    // need to be loaded, and reference targets (such as reward kits) are not included.
    let after: Tree = revision
        .manifest
        .iter()
        .map(|(path, object)| (path.clone(), (object.kind == "file").then(Vec::new)))
        .collect();
    let mut before = after.clone();
    for change in &revision.entry.changes {
        if let Some(object) = &change.before {
            before.insert(change.path.clone(), (object.kind == "file").then(Vec::new));
        } else {
            before.remove(&change.path);
        }
    }
    revision.entry.changes.iter().any(|change| {
        [(path, &after), (previous_path, &before)]
            .iter()
            .any(|(scope, tree)| {
                crate::resource_relations::asset_owner(&change.path, tree)
                    .is_some_and(|(source, _, _)| nested(scope, &source.path))
            })
    })
}

fn manifest_files(value: &Manifest) -> Vec<ProjectFile> {
    value
        .iter()
        .map(|(path, object)| ProjectFile {
            path: path.clone(),
            kind: object.kind.clone(),
            size: object.size,
            version: object.hash.clone().unwrap_or_else(|| {
                hex_digest(
                    &serde_json::to_vec(
                        &value
                            .iter()
                            .filter(|(child, _)| nested(path, child))
                            .map(|(child, object)| (child, &object.hash))
                            .collect::<Vec<_>>(),
                    )
                    .unwrap(),
                )
            }),
        })
        .collect()
}

impl ProjectFiles {
    pub(super) fn history_state(project_id: &str) -> RefCell<HistoryState> {
        RefCell::new(HistoryState {
            project_id: project_id.into(),
            latest: None,
        })
    }
    fn history_directory(&self) -> PathBuf {
        self.root.join(".hanshu/service/history")
    }
    // Every ancestor is checked again before access, including after startup.
    fn history_path(&self, relative: &str, create_parent: bool) -> Result<PathBuf> {
        let root = self.history_directory();
        for ancestor in [
            self.root.join(".hanshu"),
            self.root.join(".hanshu/service"),
            root.clone(),
        ] {
            Self::checked_directory(&ancestor, create_parent)?;
        }
        let mut current = root;
        let parts: Vec<_> = relative.split('/').collect();
        for (index, part) in parts.iter().enumerate() {
            require(
                !part.is_empty() && *part != "." && *part != ".." && !part.contains(['\\', ':']),
                "storage",
                "历史存储路径无效",
            )?;
            current.push(part);
            if index + 1 < parts.len() {
                Self::checked_directory(&current, create_parent)?;
            }
        }
        if let Ok(meta) = fs::symlink_metadata(&current) {
            require(!reparse(&meta), "storage", "历史存储不能是链接")?;
        }
        Ok(current)
    }
    fn revision_path(&self, sequence: u64, create: bool) -> Result<PathBuf> {
        require(
            sequence > 0 && sequence <= MAX_SEQUENCE,
            "invalid",
            "历史版本编号无效",
        )?;
        self.history_path(&format!("revisions/{sequence:020}.json.gz"), create)
    }
    fn object_path(&self, hash: &str, create: bool) -> Result<PathBuf> {
        require(valid_hash(hash), "storage", "历史内容摘要无效")?;
        self.history_path(&format!("objects/{}/{}.gz", &hash[..2], hash), create)
    }
    fn read_revision(&self, sequence: u64) -> Result<HistoryRevision> {
        let path = self.revision_path(sequence, false)?;
        require(path.exists(), "not_found", "历史版本不存在")?;
        let bytes = decode_gzip(&path, MAX_METADATA)?;
        let revision: HistoryRevision = serde_json::from_slice(&bytes)
            .map_err(|_| Error::new("storage", "历史版本记录损坏"))?;
        self.validate_revision(&revision)?;
        require(
            revision.entry.sequence == sequence,
            "storage",
            "历史序号与归档不一致",
        )?;
        Ok(revision)
    }
    fn validate_revision(&self, revision: &HistoryRevision) -> Result<()> {
        require(
            revision.entry.project_id == self.history.borrow().project_id
                && revision.entry.sequence > 0
                && revision.entry.sequence <= MAX_SEQUENCE
                && matches!(
                    revision.entry.kind.as_str(),
                    "baseline" | "edit" | "external" | "restore"
                )
                && revision.entry.group_id <= revision.entry.sequence
                && revision.entry.group_id > 0
                && revision.entry.label.is_none(),
            "storage",
            "历史版本元数据无效",
        )?;
        validate_manifest(&revision.manifest)?;
        require(
            revision.entry.changes.len() <= 32768,
            "storage",
            "历史变更过多",
        )?;
        for change in &revision.entry.changes {
            path_ok(&change.path)?;
            require(
                change.after.as_ref() == revision.manifest.get(&change.path),
                "storage",
                "历史变更与清单不一致",
            )?;
            if let Some(before) = &change.before {
                validate_manifest(&BTreeMap::from([(change.path.clone(), before.clone())]))?;
            }
        }
        for movement in &revision.entry.moves {
            path_ok(&movement.from)?;
            path_ok(&movement.to)?;
        }
        Ok(())
    }
    pub(super) fn load_history(&self) -> Result<()> {
        self.history_path("revisions/placeholder", true)?;
        self.history_path("objects/placeholder", true)?;
        self.history_path("labels/placeholder", true)?;
        let dir = self.history_path("revisions", false)?;
        let mut sequences = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let sequence = name
                .strip_suffix(".json.gz")
                .filter(|s| s.len() == 20)
                .and_then(|s| s.parse::<u64>().ok())
                .ok_or_else(|| Error::new("storage", "历史归档名称无效"))?;
            require(
                !reparse(&fs::symlink_metadata(entry.path())?),
                "storage",
                "历史归档不能是链接",
            )?;
            sequences.push(sequence);
        }
        sequences.sort_unstable();
        for (index, sequence) in sequences.iter().enumerate() {
            require(
                *sequence == index as u64 + 1,
                "storage",
                "历史版本序列不完整",
            )?;
        }
        if let Some(sequence) = sequences.last() {
            self.history.borrow_mut().latest = Some(self.read_revision(*sequence)?);
        }
        Ok(())
    }
    fn store_objects(&self, tree: &Tree, value: &Manifest) -> Result<()> {
        let state = self.history.borrow();
        for (path, object) in value {
            if let Some(hash) = &object.hash {
                // Unchanged content is already referenced by a durable revision. A newly
                // referenced older object is checked before it can back another commit.
                if state
                    .latest
                    .as_ref()
                    .and_then(|revision| revision.manifest.get(path))
                    == Some(object)
                {
                    continue;
                }
                let stored = self.object_path(hash, true)?;
                if stored.exists() {
                    self.history_object(object)?;
                } else {
                    self.atomic(&stored, &gzip(tree[path].as_deref().unwrap())?)?;
                }
            }
        }
        Ok(())
    }
    pub(super) fn prepare_history(
        &self,
        tree: &Tree,
        context: HistoryContext,
    ) -> Result<Option<HistoryRevision>> {
        let next = manifest(tree);
        validate_manifest(&next)?;
        let state = self.history.borrow();
        let previous = state.latest.as_ref();
        if previous.is_some_and(|previous| previous.manifest == next) {
            return Ok(None);
        }
        let empty = Manifest::new();
        let before = previous.map_or(&empty, |previous| &previous.manifest);
        let sequence = previous.map_or(1, |previous| previous.entry.sequence + 1);
        require(
            sequence <= MAX_SEQUENCE,
            "storage",
            "历史版本序号已达到上限",
        )?;
        let continue_group = previous.filter(|previous| {
            !previous.isolated
                && !context.isolated
                && previous.entry.kind == "edit"
                && context.kind == "edit"
                && context.now.saturating_sub(previous.entry.time) < 30_000
                && context.now.saturating_sub(previous.group_started_at) < 300_000
        });
        let group_id = continue_group.map_or(sequence, |previous| previous.entry.group_id);
        let group_started_at =
            continue_group.map_or(context.now, |previous| previous.group_started_at);
        let changes = before
            .keys()
            .chain(next.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|path| before.get(*path) != next.get(*path))
            .map(|path| HistoryChange {
                path: path.clone(),
                before: before.get(path).cloned(),
                after: next.get(path).cloned(),
            })
            .collect();
        let revision = HistoryRevision {
            entry: HistoryEntry {
                sequence,
                project_id: state.project_id.clone(),
                time: context.now,
                kind: context.kind,
                transaction_id: context.transaction_id,
                actor: context.actor,
                changes,
                moves: context.moves,
                group_id,
                label: None,
            },
            manifest: next,
            group_started_at,
            isolated: context.isolated,
        };
        drop(state);
        // Discover an oversized manifest before a durable commit decision, never while
        // trying to publish an already accepted transaction during crash recovery.
        require(
            serde_json::to_vec(&revision)
                .map_err(|_| Error::new("storage", "历史版本编码失败"))?
                .len()
                <= MAX_METADATA,
            "invalid",
            "历史版本元数据过大，修改尚未提交",
        )?;
        self.store_objects(tree, &revision.manifest)?;
        Ok(Some(revision))
    }
    pub(super) fn publish_history(&self, revision: &HistoryRevision) -> Result<()> {
        self.validate_revision(revision)?;
        let sequence = revision.entry.sequence;
        let path = self.revision_path(sequence, true)?;
        if path.exists() {
            require(
                self.read_revision(sequence)? == *revision,
                "storage",
                "已发布历史与提交决议不一致",
            )?;
        } else {
            let latest = self
                .history
                .borrow()
                .latest
                .as_ref()
                .map_or(0, |r| r.entry.sequence);
            require(sequence == latest + 1, "storage", "历史提交序号不连续")?;
            let bytes = serde_json::to_vec(revision)
                .map_err(|_| Error::new("storage", "历史版本编码失败"))?;
            require(bytes.len() <= MAX_METADATA, "storage", "历史版本元数据过大")?;
            self.atomic(&path, &gzip(&bytes)?)?;
        }
        let mut state = self.history.borrow_mut();
        if state.latest.as_ref().map_or(0, |r| r.entry.sequence) <= sequence {
            state.latest = Some(revision.clone());
        }
        Ok(())
    }
    pub(super) fn validate_history_transaction(
        &self,
        revision: &HistoryRevision,
        receipt: &FileTransactionReceipt,
        subject_id: &str,
    ) -> Result<()> {
        self.validate_revision(revision)?;
        require(
            revision.entry.transaction_id.as_ref() == Some(&receipt.transaction_id)
                && revision
                    .entry
                    .actor
                    .as_ref()
                    .is_some_and(|actor| actor.subject_id == subject_id)
                && matches!(revision.entry.kind.as_str(), "edit" | "restore"),
            "storage",
            "历史与提交决议的事务身份不一致",
        )?;
        let entries = receipt
            .tree
            .as_ref()
            .ok_or_else(|| Error::new("storage", "历史提交缺少工程清单"))?;
        require(
            entries.entries.len() == revision.manifest.len(),
            "storage",
            "历史与提交决议文件数量不一致",
        )?;
        for entry in &entries.entries {
            let object = revision
                .manifest
                .get(&entry.path)
                .ok_or_else(|| Error::new("storage", "历史与提交决议路径不一致"))?;
            let version = object.hash.clone().unwrap_or_else(|| {
                hex_digest(
                    &serde_json::to_vec(
                        &revision
                            .manifest
                            .iter()
                            .filter(|(path, _)| nested(&entry.path, path))
                            .map(|(path, object)| (path, &object.hash))
                            .collect::<Vec<_>>(),
                    )
                    .unwrap(),
                )
            });
            require(
                entry.kind == object.kind && entry.size == object.size && entry.version == version,
                "storage",
                "历史内容与提交决议不一致",
            )?;
        }
        Ok(())
    }
    pub(super) fn sync_history(&self) -> Result<()> {
        self.sync_history_at(crate::now_ms())
    }
    pub(super) fn sync_history_at(&self, now: u64) -> Result<()> {
        require(
            self.healthy && !self.journal().exists(),
            "storage",
            "提交决议待恢复，暂不能读取工程历史",
        )?;
        self.sync_history_tree(&self.scan()?, now)
    }
    pub(super) fn sync_history_tree(&self, tree: &Tree, now: u64) -> Result<()> {
        require(
            self.healthy && !self.journal().exists(),
            "storage",
            "提交决议待恢复，暂不能读取工程历史",
        )?;
        let kind = if self.history.borrow().latest.is_none() {
            "baseline"
        } else {
            "external"
        };
        if let Some(revision) = self.prepare_history(
            tree,
            HistoryContext {
                actor: None,
                now,
                kind: kind.into(),
                transaction_id: None,
                isolated: true,
                moves: vec![],
            },
        )? {
            self.publish_history(&revision)?;
        }
        Ok(())
    }
    fn history_object(&self, object: &HistoryObject) -> Result<Vec<u8>> {
        let hash = object
            .hash
            .as_deref()
            .ok_or_else(|| Error::new("invalid", "目录没有正文"))?;
        let bytes = decode_gzip(&self.object_path(hash, false)?, MAX_FILE)?;
        require(
            bytes.len() as u64 == object.size && hex_digest(&bytes) == hash,
            "storage",
            "历史内容对象与摘要不符",
        )?;
        Ok(bytes)
    }
    pub(super) fn history_tree(&self, sequence: u64) -> Result<Tree> {
        let revision = self.read_revision(sequence)?;
        revision
            .manifest
            .into_iter()
            .map(|(path, object)| {
                let value = if object.kind == "directory" {
                    None
                } else {
                    Some(self.history_object(&object)?)
                };
                Ok((path, value))
            })
            .collect()
    }
    fn label(&self, sequence: u64) -> Result<Option<String>> {
        let path = self.history_path(&format!("labels/{sequence:020}.json"), false)?;
        if !path.exists() {
            return Ok(None);
        }
        let label: Option<String> = serde_json::from_slice(&bounded_file(&path, 4096)?)
            .map_err(|_| Error::new("storage", "历史版本名称损坏"))?;
        require(
            label.as_ref().is_none_or(|name| {
                !name.trim().is_empty()
                    && name.chars().count() <= 120
                    && !name.chars().any(char::is_control)
            }),
            "storage",
            "历史版本名称无效",
        )?;
        Ok(label)
    }
    pub(super) fn history_head(&self) -> u64 {
        self.history
            .borrow()
            .latest
            .as_ref()
            .map_or(0, |r| r.entry.sequence)
    }
    fn tracked_history_path(&self, sequence: u64, path: &str) -> Result<String> {
        let mut path = path.to_owned();
        for index in (sequence.saturating_add(1)..=self.history_head()).rev() {
            for movement in self.read_revision(index)?.entry.moves.iter().rev() {
                if nested(&movement.to, &path) {
                    path = format!("{}{}", movement.from, &path[movement.to.len()..]);
                }
            }
        }
        Ok(path)
    }
    /// A deleted incarnation still fences old commands when restored. Use the complete
    /// recorded high-water mark rather than only today's index and the chosen old state.
    pub(super) fn history_skin_revision_floor(&self) -> Result<u64> {
        let mut hashes = BTreeSet::new();
        let mut floor = 0;
        for sequence in 1..=self.history_head() {
            let revision = self.read_revision(sequence)?;
            if let Some(object) = revision.manifest.get(crate::skin_patch::LIBRARY_PATH) {
                if let Some(hash) = &object.hash {
                    if !hashes.insert(hash.clone()) {
                        continue;
                    }
                    let value: serde_json::Value =
                        serde_json::from_slice(&self.history_object(object)?)
                            .map_err(|_| Error::new("storage", "历史皮肤库不是合法 JSON"))?;
                    // Pre-migration libraries may exist in the initial baseline. They cannot
                    // supply semantic entry revisions; later valid schema-5 versions do.
                    if value["schemaVersion"] != 5 {
                        continue;
                    }
                    floor = floor.max(crate::skin_patch::revision(&value["revision"])?);
                    if let Some(entries) = value["entries"].as_array() {
                        for entry in entries {
                            floor = floor.max(crate::skin_patch::revision(&entry["revision"])?);
                        }
                    }
                }
            }
        }
        Ok(floor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deleted_skin_incarnations_remain_in_the_restore_revision_floor() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".hanshu/skinmanager")).unwrap();
        fs::write(dir.path().join(crate::skin_patch::LIBRARY_PATH),
            br#"{"schemaVersion":5,"revision":2,"entries":[{"entryId":"gone","revision":1000}],"folders":[]}"#).unwrap();
        let engine = Engine::open_project(dir.path()).unwrap();
        let store = engine.files.as_ref().unwrap();
        fs::write(
            dir.path().join(crate::skin_patch::LIBRARY_PATH),
            br#"{"schemaVersion":5,"revision":3,"entries":[],"folders":[]}"#,
        )
        .unwrap();
        store.sync_history().unwrap();
        assert_eq!(store.history_skin_revision_floor().unwrap(), 1000);
    }
}

impl Engine {
    pub fn history_list(
        &self,
        sid: &str,
        before: Option<u64>,
        limit: usize,
        path: Option<&str>,
    ) -> Result<HistoryPage> {
        self.role(sid)?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        if let Some(path) = path {
            path_ok(path)?;
        }
        require(
            (1..=100).contains(&limit),
            "invalid",
            "历史页大小须为 1 至 100",
        )?;
        store.sync_history()?;
        let head = store.history_head();
        let mut sequence = before.unwrap_or(head + 1).min(head + 1).saturating_sub(1);
        let mut entries = Vec::new();
        // Reconstruct the tracked historical path from the current name even on later pages.
        let mut tracked = path.map(str::to_owned);
        if tracked.is_some() {
            for index in (sequence + 1..=head).rev() {
                let revision = store.read_revision(index)?;
                for movement in revision.entry.moves.iter().rev() {
                    if let Some(current) = tracked.as_mut() {
                        if nested(&movement.to, current) {
                            *current =
                                format!("{}{}", movement.from, &current[movement.to.len()..]);
                        }
                    }
                }
            }
        }
        let mut visited = 0;
        while sequence > 0 && entries.len() < limit && visited < 1000 {
            let revision = store.read_revision(sequence)?;
            let after_path = tracked.clone();
            for movement in revision.entry.moves.iter().rev() {
                if let Some(current) = tracked.as_mut() {
                    if nested(&movement.to, current) {
                        *current = format!("{}{}", movement.from, &current[movement.to.len()..]);
                    }
                }
            }
            let matches = after_path.as_ref().is_none_or(|path| {
                scope_matches(&revision, path, tracked.as_deref().unwrap_or(path))
            });
            let mut entry = revision.entry;
            if matches {
                entry.label = store.label(sequence)?;
                entries.push(entry);
            }
            sequence -= 1;
            visited += 1;
        }
        Ok(HistoryPage {
            entries,
            next_before: (sequence > 0).then_some(sequence + 1),
            head,
            project_id: self.data.id.clone(),
        })
    }
    pub fn history_tree(&self, sid: &str, sequence: u64) -> Result<HistoryTree> {
        self.history_tree_scoped(sid, sequence, None)
    }
    pub fn history_tree_scoped(
        &self,
        sid: &str,
        sequence: u64,
        path: Option<&str>,
    ) -> Result<HistoryTree> {
        self.role(sid)?;
        if let Some(path) = path {
            path_ok(path)?;
        }
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        store.sync_history()?;
        let revision = store.read_revision(sequence)?;
        let scope_path = path
            .map(|path| store.tracked_history_path(sequence, path))
            .transpose()?;
        let mut entries = manifest_files(&revision.manifest);
        if let Some(scope) = &scope_path {
            let structure: Tree = revision
                .manifest
                .iter()
                .map(|(path, object)| (path.clone(), (object.kind == "file").then(Vec::new)))
                .collect();
            entries.retain(|entry| {
                nested(scope, &entry.path)
                    || (scope.starts_with("src/")
                        && crate::resource_relations::asset_owner(&entry.path, &structure)
                            .is_some_and(|(source, _, _)| nested(scope, &source.path)))
            });
        }
        Ok(HistoryTree {
            sequence,
            scope_path,
            entries,
        })
    }
    pub fn history_content(&self, sid: &str, sequence: u64, path: &str) -> Result<HistoryContent> {
        self.role(sid)?;
        path_ok(path)?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        store.sync_history()?;
        let revision = store.read_revision(sequence)?;
        let object = revision
            .manifest
            .get(path)
            .ok_or_else(|| Error::new("not_found", "此版本没有该文件"))?;
        let bytes = store.history_object(object)?;
        Ok(HistoryContent {
            sequence,
            path: path.into(),
            content: STANDARD.encode(&bytes),
            version: object.hash.clone().unwrap(),
            size: bytes.len() as u64,
        })
    }
    pub fn history_label(
        &self,
        sid: &str,
        sequence: u64,
        label: Option<String>,
        _now: u64,
    ) -> Result<HistoryEntry> {
        self.writer(sid)?;
        let label = label.map(|value| value.trim().to_owned());
        if let Some(label) = &label {
            crate::text(label)?;
            require(
                !label.chars().any(char::is_control),
                "invalid",
                "版本名称不能包含控制字符",
            )?;
        }
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        store.sync_history()?;
        let mut entry = store.read_revision(sequence)?.entry;
        store.atomic(
            &store.history_path(&format!("labels/{sequence:020}.json"), true)?,
            &serde_json::to_vec(&label).map_err(|_| Error::new("storage", "版本名称编码失败"))?,
        )?;
        entry.label = label;
        Ok(entry)
    }
    pub fn history_stats(&self, sid: &str) -> Result<HistoryStats> {
        self.role(sid)?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        store.sync_history()?;
        let mut stats = HistoryStats {
            head: store.history_head(),
            revisions: store.history_head(),
            objects: 0,
            stored_bytes: 0,
            raw_bytes: 0,
            named_versions: 0,
        };
        for sequence in 1..=stats.head {
            store.read_revision(sequence)?;
            stats.stored_bytes +=
                fs::symlink_metadata(store.revision_path(sequence, false)?)?.len();
            let label_path = store.history_path(&format!("labels/{sequence:020}.json"), false)?;
            if label_path.exists() {
                stats.stored_bytes += fs::symlink_metadata(label_path)?.len();
                if store.label(sequence)?.is_some() {
                    stats.named_versions += 1;
                }
            }
        }
        // Count every stored object, including harmless objects staged by an interrupted
        // pre-commit attempt. Report actual disk use rather than only reachable content.
        for shard in fs::read_dir(store.history_path("objects", false)?)? {
            let shard = shard?;
            let name = shard.file_name().to_string_lossy().into_owned();
            require(
                name.len() == 2
                    && name
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
                "storage",
                "历史内容分片名称无效",
            )?;
            ProjectFiles::checked_directory(&shard.path(), false)?;
            for object in fs::read_dir(shard.path())? {
                let object = object?;
                let name = object.file_name().to_string_lossy().into_owned();
                let hash = name
                    .strip_suffix(".gz")
                    .ok_or_else(|| Error::new("storage", "历史内容归档名称无效"))?;
                let path = store.object_path(hash, false)?;
                require(path == object.path(), "storage", "历史内容对象位于错误分片")?;
                let meta = fs::symlink_metadata(&path)?;
                require(
                    meta.is_file()
                        && meta.len() >= 18
                        && meta.len() <= (MAX_FILE + 1024 * 1024) as u64,
                    "storage",
                    "历史内容归档大小无效",
                )?;
                let mut file = fs::File::open(path)?;
                file.seek(SeekFrom::End(-4))?;
                let mut footer = [0u8; 4];
                file.read_exact(&mut footer)?;
                let raw_size = u32::from_le_bytes(footer) as u64;
                require(
                    raw_size <= MAX_FILE as u64,
                    "storage",
                    "历史解压内容超过读取上限",
                )?;
                stats.objects += 1;
                stats.raw_bytes += raw_size;
                stats.stored_bytes += meta.len();
            }
        }
        Ok(stats)
    }
}
