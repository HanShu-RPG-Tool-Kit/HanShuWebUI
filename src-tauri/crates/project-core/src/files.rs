//! The server owns the ordinary project directory. Clients receive names/versions, never OS handles.
//! A checked batch has an on-disk undo journal; interrupted batches roll back before serving clients.
#[path = "history.rs"]
mod history;
#[path = "history_restore.rs"]
mod history_restore;
#[path = "progress_commands.rs"]
mod progress_commands;
#[path = "file_transactions.rs"]
mod transactions;
use crate::{
    require, secret, Engine, Error, FileActivity, FilePresence, Lease, Result, Session, LEASE_TTL,
    SESSION_TTL,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
pub use history::{
    HistoryActor, HistoryChange, HistoryContent, HistoryEntry, HistoryMove, HistoryObject,
    HistoryPage, HistoryStats, HistoryTree,
};
use history::{HistoryContext, HistoryState};
pub use history_restore::{
    HistoryRestoreChange, HistoryRestorePlan, HistoryRestoreRequest, HistoryRestoreSelection,
};
pub use progress_commands::{
    ProgressCommand, ProgressCommandResult, ProgressEffect, ProgressLanguage, ProgressSlot,
    ProgressTarget,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use transactions::{CommitJournal, TransactionCache, TransactionRecord};
pub use transactions::{FileTransactionError, FileTransactionReceipt, FileTransactionStatus};
use ts_rs::TS;

pub(crate) type Tree = BTreeMap<String, Option<Vec<u8>>>;
const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_TREE: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    pub kind: String,
    pub version: String,
    #[ts(type = "number")]
    pub size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileTree {
    #[ts(type = "number")]
    pub revision: u64,
    pub entries: Vec<ProjectFile>,
}
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChange {
    pub op: String,
    pub path: String,
    pub version: Option<String>,
    pub content: Option<String>,
    pub destination: Option<String>,
    pub destination_version: Option<String>,
    pub lease_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct UndoEntry {
    kind: String,
    content: Option<String>,
}

pub(crate) struct ProjectFiles {
    root: PathBuf,
    pub revision: u64,
    healthy: bool,
    transactions: std::cell::RefCell<TransactionCache>,
    history: std::cell::RefCell<HistoryState>,
}

pub(crate) fn path_ok(path: &str) -> Result<()> {
    require(
        !path.is_empty() && path.len() <= 1024,
        "invalid",
        "工程路径无效",
    )?;
    for part in path.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        require(
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with(['.', ' '])
                && !part
                    .chars()
                    .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
                && ![
                    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
                    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
                    "LPT8", "LPT9",
                ]
                .contains(&stem.as_str()),
            "invalid",
            "工程路径包含非法名称",
        )?;
    }
    require(
        path == "project.json"
            || ["src", "meta", "assets", ".hanshu/skinmanager"]
                .iter()
                .any(|p| path == *p || path.starts_with(&format!("{p}/"))),
        "forbidden",
        "路径不属于可访问的工程资源；服务数据不可访问",
    )
}
pub(crate) fn nested(a: &str, b: &str) -> bool {
    a == b || b.starts_with(&format!("{a}/"))
}
pub(crate) fn version(tree: &Tree, path: &str) -> Option<String> {
    tree.get(path).map(|bytes| match bytes {
        Some(bytes) => hex_digest(bytes),
        None => hex_digest(
            &serde_json::to_vec(
                &tree
                    .iter()
                    .filter(|(p, _)| nested(path, p))
                    .map(|(p, b)| (p, b.as_ref().map(|v| hex_digest(v))))
                    .collect::<Vec<_>>(),
            )
            .unwrap(),
        ),
    })
}
fn hex_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn reparse(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
impl ProjectFiles {
    fn open(root: &Path, project_id: &str) -> Result<Self> {
        let mut out = Self {
            root: root.canonicalize()?,
            revision: 1,
            healthy: true,
            transactions: std::cell::RefCell::new(TransactionCache::default()),
            history: Self::history_state(project_id),
        };
        out.prepare_staging()?;
        out.load_transactions()?;
        out.load_history()?;
        out.recover_transaction()?;
        out.sync_history()?;
        Ok(out)
    }
    fn journal(&self) -> PathBuf {
        self.root.join(".hanshu/service/file-undo.json")
    }
    fn safe(&self, path: &str) -> Result<PathBuf> {
        path_ok(path)?;
        let mut current = self.root.clone();
        for part in path.split('/') {
            current.push(part);
            match fs::symlink_metadata(&current) {
                Ok(m) => require(!reparse(&m), "forbidden", "工程内不允许符号链接或目录联接")?,
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(current)
    }
    fn scan(&self) -> Result<Tree> {
        require(self.healthy, "storage", "工程事务恢复失败，请重启服务")?;
        let mut tree = Tree::new();
        let mut size = 0;
        fn visit(
            store: &ProjectFiles,
            path: &str,
            tree: &mut Tree,
            size: &mut usize,
        ) -> Result<()> {
            let full = store.safe(path)?;
            let meta = match fs::metadata(&full) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(e.into()),
            };
            require(tree.len() < 16384, "busy", "工程文件数量超过首版限制")?;
            if meta.is_dir() {
                tree.insert(path.into(), None);
                for entry in fs::read_dir(full)? {
                    let entry = entry?;
                    visit(
                        store,
                        &format!("{path}/{}", entry.file_name().to_string_lossy()),
                        tree,
                        size,
                    )?;
                }
            } else {
                require(
                    meta.len() <= MAX_FILE as u64,
                    "busy",
                    "单个工程文件超过 32 MiB",
                )?;
                *size += meta.len() as usize;
                require(*size <= MAX_TREE, "busy", "工程超过首版 256 MiB 限制")?;
                tree.insert(path.into(), Some(fs::read(full)?));
            }
            Ok(())
        }
        for root in [
            "project.json",
            "src",
            "meta",
            "assets",
            ".hanshu/skinmanager",
        ] {
            visit(self, root, &mut tree, &mut size)?;
        }
        let mut names = std::collections::BTreeSet::new();
        for path in tree.keys() {
            require(
                names.insert(path.to_lowercase()),
                "conflict",
                "工程存在大小写冲突的文件名",
            )?;
        }
        Ok(tree)
    }
    fn snapshot(&self) -> Result<ProjectFileTree> {
        let tree = self.scan()?;
        self.sync_history_tree(&tree, crate::now_ms())?;
        Ok(self.tree_snapshot(&tree, self.revision))
    }
    fn tree_snapshot(&self, tree: &Tree, revision: u64) -> ProjectFileTree {
        ProjectFileTree {
            revision,
            entries: tree
                .iter()
                .map(|(path, b)| ProjectFile {
                    path: path.clone(),
                    kind: if b.is_some() { "file" } else { "directory" }.into(),
                    version: version(tree, path).unwrap(),
                    size: b.as_ref().map_or(0, |b| b.len() as u64),
                })
                .collect(),
        }
    }
    fn staging(&self) -> PathBuf {
        self.root.join(".hanshu/service/write-staging")
    }
    fn prepare_staging(&self) -> Result<()> {
        let staging = self.staging();
        if let Ok(meta) = fs::symlink_metadata(&staging) {
            require(!reparse(&meta), "storage", "事务暂存目录不能是链接")?;
        }
        fs::create_dir_all(&staging)?;
        // Only this service's private temporary files are removable. The process
        // lock is already held, so none can belong to an active writer.
        for entry in fs::read_dir(staging)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            require(!reparse(&meta), "storage", "事务暂存文件不能是链接")?;
            if meta.is_file() && entry.file_name().to_string_lossy().starts_with("atomic-") {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
    fn atomic(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        fs::create_dir_all(path.parent().unwrap())?;
        // Keep crash leftovers out of the authoritative resource tree. Both paths
        // stay on the project volume; persist still performs an atomic rename.
        let staging = self.staging();
        require(
            !reparse(&fs::symlink_metadata(&staging)?),
            "storage",
            "事务暂存目录不能是链接",
        )?;
        let mut file = tempfile::Builder::new()
            .prefix("atomic-")
            .tempfile_in(staging)?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        file.persist(path)
            .map_err(|_| Error::new("storage", "工程文件原子替换失败"))?;
        Ok(())
    }
    // None = absent, Some(None) = directory, Some(Some(bytes)) = file.
    fn apply(&mut self, changes: &BTreeMap<String, Option<Option<Vec<u8>>>>) -> Result<()> {
        let mut paths = changes.keys().collect::<Vec<_>>();
        paths.sort_by_key(|p| std::cmp::Reverse(p.len()));
        for p in &paths {
            let full = self.safe(p)?;
            match fs::symlink_metadata(&full) {
                Ok(meta) => {
                    // A checked history replacement may change file/directory type.
                    // Descendants are removed first; rollback uses this same path.
                    let remove = changes[*p]
                        .as_ref()
                        .is_none_or(|next| meta.is_dir() == next.is_some());
                    if remove {
                        if meta.is_dir() {
                            fs::remove_dir(full)?;
                        } else {
                            fs::remove_file(full)?;
                        }
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                Err(error) => return Err(error.into()),
            }
        }
        paths.reverse();
        for p in paths {
            if let Some(value) = &changes[p] {
                let full = self.safe(p)?;
                match value {
                    None => fs::create_dir_all(full)?,
                    Some(bytes) => self.atomic(&full, bytes)?,
                }
            }
        }
        Ok(())
    }
    fn commit(
        &mut self,
        changes: &[FileChange],
        mut record: TransactionRecord,
        old: Tree,
        context: HistoryContext,
    ) -> Result<FileTransactionReceipt> {
        self.sync_history_tree(&old, context.now)?;
        let mut next = old.clone();
        require(
            !changes.is_empty() && changes.len() <= 4096,
            "invalid",
            "文件事务为空或过大",
        )?;
        let importing = changes
            .iter()
            .filter(|c| c.op == "skin-library-command")
            .filter_map(|c| STANDARD.decode(c.content.as_deref()?).ok())
            .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .find(|value| value["command"] == "import-entry")
            .and_then(|value| value["entry"]["skinId"].as_str().map(str::to_owned))
            .filter(|id| skin_core::codec::is_valid_skin_id(id))
            .map(|id| format!(".hanshu/skinmanager/objects/{}/{id}.skin", &id[..2]));
        for c in changes {
            path_ok(&c.path)?;
            let identical_import_object = c.op == "write"
                && importing.as_ref() == Some(&c.path)
                && c.content
                    .as_ref()
                    .and_then(|content| STANDARD.decode(content).ok())
                    .as_ref()
                    .is_some_and(|bytes| old.get(&c.path).and_then(Option::as_ref) == Some(bytes));
            if !matches!(c.op.as_str(), "skin-entry-patch" | "skin-library-command")
                && !identical_import_object
            {
                require(
                    version(&old, &c.path) == c.version,
                    "conflict",
                    format!("{} 已被其他客户端修改，草稿仍保留", c.path).as_str(),
                )?;
            }
            match c.op.as_str() {
                "skin-library-command" => {
                    require(
                        c.path == crate::skin_patch::LIBRARY_PATH
                            && c.destination.is_none()
                            && c.destination_version.is_none(),
                        "invalid",
                        "皮肤业务操作不能指定其他路径或移动目标",
                    )?;
                    let bytes = STANDARD
                        .decode(
                            c.content
                                .as_deref()
                                .ok_or_else(|| Error::new("invalid", "皮肤业务命令缺少内容"))?,
                        )
                        .map_err(|_| Error::new("invalid", "皮肤业务命令编码无效"))?;
                    let (library, result, entries) = crate::skin_commands::apply(
                        old.get(&c.path).and_then(Option::as_deref),
                        &bytes,
                    )?;
                    require(
                        library.len() <= MAX_FILE,
                        "invalid",
                        "皮肤库索引超过 32 MiB",
                    )?;
                    next.insert(c.path.clone(), Some(library));
                    record.receipt.skin_command_result = Some(result);
                    record.receipt.skin_entries = Some(entries);
                }
                "skin-entry-patch" => {
                    require(
                        c.path == crate::skin_patch::LIBRARY_PATH
                            && c.destination.is_none()
                            && c.destination_version.is_none(),
                        "invalid",
                        "皮肤条目修改不能指定其他路径或移动目标",
                    )?;
                    let bytes = STANDARD
                        .decode(
                            c.content
                                .as_deref()
                                .ok_or_else(|| Error::new("invalid", "皮肤条目修改缺少内容"))?,
                        )
                        .map_err(|_| Error::new("invalid", "皮肤条目修改编码无效"))?;
                    let before = old
                        .get(&c.path)
                        .and_then(Option::as_ref)
                        .ok_or_else(|| Error::new("conflict", "皮肤库索引不存在或已被删除"))?;
                    let (library, entry) = crate::skin_patch::apply(before, &bytes)?;
                    require(
                        library.len() <= MAX_FILE,
                        "invalid",
                        "皮肤库索引超过 32 MiB",
                    )?;
                    next.insert(c.path.clone(), Some(library));
                    record.receipt.skin_entries = Some(vec![entry]);
                }
                // A read-set assertion participates in the same checked batch.
                // It lets a conflict resolution adopt some server resources while
                // modifying others, without racing a second writer in between.
                "check" => {
                    require(
                        c.content.is_none() && c.destination.is_none(),
                        "invalid",
                        "版本检查不能包含写入内容或移动目标",
                    )?;
                }
                "write" => {
                    require(c.content.is_some(), "invalid", "写入缺少文件正文")?;
                    require(
                        !matches!(next.get(&c.path), Some(None)),
                        "conflict",
                        "不能用文件覆盖目录",
                    )?;
                    let bytes = STANDARD
                        .decode(c.content.as_deref().unwrap_or(""))
                        .map_err(|_| Error::new("invalid", "文件编码无效"))?;
                    require(bytes.len() <= MAX_FILE, "invalid", "文件超过 32 MiB")?;
                    if c.path.to_ascii_lowercase().ends_with(".progress") {
                        super::progress::validate(
                            std::str::from_utf8(&bytes)
                                .map_err(|_| Error::new("invalid", "进度须为 UTF-8"))?,
                        )?;
                    }
                    if c.path == "project.json" {
                        let v: serde_json::Value = serde_json::from_slice(&bytes)
                            .map_err(|_| Error::new("invalid", "工程清单无效"))?;
                        require(
                            v["version"] == 1 && v["id"].is_string() && v["name"].is_string(),
                            "invalid",
                            "工程清单无效",
                        )?;
                        if let Some(Some(before)) = old.get("project.json") {
                            let before: serde_json::Value = serde_json::from_slice(before)
                                .map_err(|_| Error::new("storage", "工程清单损坏"))?;
                            require(v["id"] == before["id"], "invalid", "不能替换工程身份")?;
                        }
                    }
                    if c.path == ".hanshu/skinmanager/library.json" {
                        let library: serde_json::Value = serde_json::from_slice(&bytes)
                            .map_err(|_| Error::new("invalid", "皮肤库索引不是合法 JSON"))?;
                        require(
                            library["schemaVersion"] == 5
                                && library["revision"].is_u64()
                                && library["entries"].is_array()
                                && library["folders"].is_array(),
                            "invalid",
                            "皮肤库索引结构无效",
                        )?;
                        crate::skin_patch::validate_replacement(
                            old.get(&c.path).and_then(Option::as_deref),
                            &library,
                        )?;
                    }
                    next.insert(c.path.clone(), Some(bytes));
                }
                "mkdir" => {
                    require(
                        !matches!(next.get(&c.path), Some(Some(_))),
                        "conflict",
                        "目录与文件冲突",
                    )?;
                    next.insert(c.path.clone(), None);
                }
                "remove" => {
                    require(
                        c.path != "project.json"
                            && !["src", "meta", "assets", ".hanshu/skinmanager"]
                                .contains(&c.path.as_str()),
                        "forbidden",
                        "不能删除工程清单或资源根目录",
                    )?;
                    next.retain(|p, _| !nested(&c.path, p));
                }
                "move" => {
                    let dest = c
                        .destination
                        .as_deref()
                        .ok_or_else(|| Error::new("invalid", "缺少目标路径"))?;
                    path_ok(dest)?;
                    require(
                        c.path != "project.json"
                            && !["src", "meta", "assets", ".hanshu/skinmanager"]
                                .contains(&c.path.as_str())
                            && dest != "project.json"
                            && !nested(&c.path, dest)
                            && old.contains_key(&c.path),
                        "invalid",
                        "移动目标无效",
                    )?;
                    require(
                        version(&old, dest) == c.destination_version && !next.contains_key(dest),
                        "conflict",
                        "目标已存在或已变化",
                    )?;
                    let moved = next
                        .iter()
                        .filter(|(p, _)| nested(&c.path, p))
                        .map(|(p, b)| (format!("{dest}{}", &p[c.path.len()..]), b.clone()))
                        .collect::<Vec<_>>();
                    next.retain(|p, _| !nested(&c.path, p));
                    next.extend(moved);
                }
                _ => return Err(Error::new("invalid", "未知工程操作")),
            }
        }
        if let Some(entries) = &record.receipt.skin_entries {
            for entry in entries {
                crate::skin_patch::validate_object(entry, &next)?;
                if importing.is_some() {
                    crate::skin_commands::validate_import_object(entry, &next)?;
                }
            }
        }
        crate::skin_commands::validate_removed_objects(&old, &next)?;
        let mut parents = Vec::new();
        for path in next.keys() {
            let mut p = path.as_str();
            while let Some((parent, _)) = p.rsplit_once('/') {
                if parent != ".hanshu" {
                    path_ok(parent)?;
                    parents.push(parent.to_string());
                }
                p = parent;
            }
        }
        for p in parents {
            require(
                !matches!(next.get(&p), Some(Some(_))),
                "conflict",
                "父目录是文件",
            )?;
            next.entry(p).or_insert(None);
        }
        let mut names = std::collections::BTreeSet::new();
        let mut size = 0;
        for (p, b) in &next {
            require(names.insert(p.to_lowercase()), "conflict", "大小写名称冲突")?;
            size += b.as_ref().map_or(0, Vec::len);
        }
        require(
            next.len() <= 16384 && size <= MAX_TREE,
            "busy",
            "工程超过首版容量限制",
        )?;
        let paths = old
            .keys()
            .chain(next.keys())
            .collect::<std::collections::BTreeSet<_>>();
        let changed = paths
            .into_iter()
            .filter(|p| old.get(*p) != next.get(*p))
            .collect::<Vec<_>>();
        let undo = changed
            .iter()
            .map(|p| ((*p).clone(), old.get(*p).cloned()))
            .collect::<BTreeMap<_, _>>();
        let writes = changed
            .iter()
            .map(|p| ((*p).clone(), next.get(*p).cloned()))
            .collect::<BTreeMap<_, _>>();
        let encoded = undo
            .iter()
            .map(|(p, b)| {
                (
                    p,
                    UndoEntry {
                        kind: match b {
                            None => "missing",
                            Some(None) => "directory",
                            Some(Some(_)) => "file",
                        }
                        .into(),
                        content: b
                            .as_ref()
                            .and_then(|b| b.as_ref().map(|b| STANDARD.encode(b))),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        record.receipt.tree = Some(self.tree_snapshot(&next, self.revision + 1));
        let history = self.prepare_history(&next, context)?;
        self.execute_transaction(
            CommitJournal {
                committed: false,
                transaction: record,
                history,
                undo: encoded
                    .into_iter()
                    .map(|(p, entry)| (p.clone(), entry))
                    .collect(),
            },
            &writes,
        )
    }
}

impl Engine {
    /// Read-only resource facts; relations by themselves never imply a write lease.
    pub fn resource_relations(&self, sid: &str, path: &str) -> Result<crate::ResourceRelations> {
        self.role(sid)?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        store.safe(path)?;
        let mut tree = store.scan()?;
        // A new source or child is meaningful before its first save.
        tree.entry(path.into()).or_insert_with(|| Some(Vec::new()));
        Ok(crate::ResourceRelations {
            path: path.into(),
            relations: crate::resource_relations::resolve(&tree)
                .into_iter()
                .filter(|relation| crate::resource_relations::related_to(relation, path))
                .collect(),
        })
    }
    /// Observational plan only. Commit always rederives policy from the current server tree.
    pub fn plan_file_operations(
        &self,
        sid: &str,
        requests: &[crate::FileOperationRequest],
    ) -> Result<crate::ResourceOperationPlan> {
        self.role(sid)?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        for request in requests {
            store.safe(&request.path)?;
            if let Some(destination) = &request.destination {
                store.safe(destination)?;
            }
        }
        crate::resource_policy::plan(&store.scan()?, store.revision, requests)
    }
    pub fn open_project(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        // Never follow a service-directory junction into an unrelated location.
        for p in [root.join(".hanshu"), root.join(".hanshu/service")] {
            if let Ok(m) = fs::symlink_metadata(p) {
                require(!reparse(&m), "forbidden", "服务目录不能是链接")?;
            }
        }
        let mut engine = Self::open(&root.join(".hanshu/service"))?;
        engine.files = Some(ProjectFiles::open(root, &engine.data.id)?);
        Ok(engine)
    }
    pub fn files_snapshot(&self, sid: &str) -> Result<ProjectFileTree> {
        self.role(sid)?;
        self.files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?
            .snapshot()
    }
    pub fn read_project_file(
        &self,
        sid: &str,
        path: &str,
        expected: Option<&str>,
    ) -> Result<(Vec<u8>, String)> {
        self.role(sid)?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        require(store.healthy, "storage", "工程事务恢复失败，请重启服务")?;
        let full = store.safe(path)?;
        require(
            fs::metadata(&full)
                .map(|m| m.len() <= MAX_FILE as u64)
                .unwrap_or(true),
            "invalid",
            "文件过大",
        )?;
        let bytes = fs::read(full).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::new("not_found", "文件不存在")
            } else {
                e.into()
            }
        })?;
        require(bytes.len() <= MAX_FILE, "invalid", "文件过大")?;
        let version = hex_digest(&bytes);
        require(
            expected.is_none_or(|v| v == version),
            "conflict",
            "文件已变化，请刷新",
        )?;
        Ok((bytes, version))
    }
    /// Focus and free-editor intent are informational; neither acquires a lease.
    pub fn set_file_presence(
        &mut self,
        sid: &str,
        path: Option<String>,
        entry_id: Option<String>,
        activity: FileActivity,
        now: u64,
    ) -> Result<()> {
        self.expire(now);
        let role = self.role(sid)?;
        if let Some(entry_id) = &entry_id {
            require(
                path.as_deref() == Some(crate::skin_patch::LIBRARY_PATH),
                "invalid",
                "条目查看状态只能用于皮肤库",
            )?;
            require(
                !entry_id.is_empty()
                    && entry_id.len() <= 256
                    && !entry_id.chars().any(char::is_control),
                "invalid",
                "皮肤条目身份无效",
            )?;
        }
        let presence = if let Some(path) = path {
            let store = self
                .files
                .as_ref()
                .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
            let full = store.safe(&path)?;
            match fs::metadata(full) {
                Ok(metadata) => require(metadata.is_file(), "invalid", "查看对象必须是文件")?,
                // A newly created document is local until its first successful submission.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let authority_id = format!(
                "file:{}",
                crate::resource_policy::edit_authority(&path, &store.scan()?).authority_path
            );
            Some(FilePresence {
                path,
                authority_id,
                entry_id,
                activity: if role.can_write() {
                    activity
                } else {
                    FileActivity::Viewing
                },
            })
        } else {
            None
        };
        let session = &mut self.sessions.get_mut(sid).unwrap().0;
        session.file_presence = presence;
        session.expires_at = now + SESSION_TTL;
        Ok(())
    }
    /// Editing intent is independent from temporary transaction leases and is always
    /// clamped by current permission. A lease grants write authority, not UI activity.
    pub(crate) fn session_snapshot(&self, session: &Session) -> Session {
        let mut visible = session.clone();
        if let Some(presence) = &mut visible.file_presence {
            let can_write = self.role(&session.id).is_ok_and(|role| role.can_write());
            if !can_write {
                presence.activity = FileActivity::Viewing;
            }
        }
        visible
    }
    pub fn acquire_files(
        &mut self,
        sid: &str,
        paths: &[String],
        force: bool,
        now: u64,
    ) -> Result<Vec<Lease>> {
        self.expire(now);
        self.writer(sid)?;
        if force {
            self.owner(sid)?;
        }
        require(
            !paths.is_empty() && paths.len() <= 4096,
            "invalid",
            "写权请求无效",
        )?;
        // The lease mechanism knows only paths. Related locks are selected by operation policy.
        let unique = paths
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        let paths = unique.into_iter().collect::<Vec<_>>();
        let paths = paths.as_slice();
        for p in paths {
            path_ok(p)?;
            for l in self.leases.values() {
                if let Some(other) = l.resource_id.strip_prefix("file:") {
                    require(
                        l.session_id == sid || force || !(nested(p, other) || nested(other, p)),
                        "locked",
                        "其他会话持有相关资源的写权",
                    )?;
                }
            }
        }
        if force {
            self.leases.retain(|_, l| {
                !paths.iter().any(|p| {
                    l.resource_id
                        .strip_prefix("file:")
                        .is_some_and(|other| nested(p, other) || nested(other, p))
                })
            });
        }
        let mut out = Vec::new();
        for p in paths {
            let key = format!("file:{p}");
            let lease = Lease {
                id: self
                    .leases
                    .get(&key)
                    .filter(|l| l.session_id == sid)
                    .map_or_else(secret, |l| l.id.clone()),
                resource_id: key.clone(),
                session_id: sid.into(),
                expires_at: now + LEASE_TTL,
            };
            self.leases.insert(key, lease.clone());
            out.push(lease);
        }
        Ok(out)
    }
    fn validate_file_changes(
        &self,
        sid: &str,
        changes: &[FileChange],
        now: u64,
        trusted_restore: bool,
    ) -> Result<Tree> {
        self.writer(sid)?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        let tree = store.scan()?;
        let requests = changes
            .iter()
            .map(|change| {
                Ok(crate::FileOperationRequest {
                    op: crate::FileOperationKind::parse(&change.op)?,
                    path: change.path.clone(),
                    destination: change.destination.clone(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let plan = if trusted_restore {
            crate::resource_policy::plan_restore(&tree, store.revision, &requests)?
        } else {
            crate::resource_policy::plan(&tree, store.revision, &requests)?
        };
        for operation in &plan.operations {
            require(
                changes.iter().any(|change| {
                    change.path == operation.path
                        && crate::FileOperationKind::parse(&change.op).ok() == Some(operation.op)
                        && change.destination == operation.destination
                }),
                "invalid",
                "操作必须包含服务器策略推导的全部关联资源",
            )?;
        }
        for path in &plan.lease_paths {
            require(
                self.leases
                    .get(&format!("file:{path}"))
                    .is_some_and(|lease| lease.session_id == sid && lease.expires_at > now),
                "locked",
                "缺少资源操作策略要求的写权",
            )?;
            for lease in self.leases.values() {
                if let Some(other) = lease.resource_id.strip_prefix("file:") {
                    require(
                        lease.session_id == sid || !(nested(path, other) || nested(other, path)),
                        "locked",
                        "相关目录有其他编辑者",
                    )?;
                }
            }
        }
        for change in changes {
            self.require_lease(sid, &format!("file:{}", change.path), &change.lease_id, now)?;
        }
        // The policy check and application share this scan so version checks and relationship
        // closure are evaluated against the same authoritative state.
        Ok(tree)
    }
    pub fn renew_files(&mut self, sid: &str, ids: &[String], now: u64) -> Result<()> {
        self.expire(now);
        self.writer(sid)?;
        require(ids.len() <= 4096, "invalid", "写权续期请求过大")?;
        for l in self.leases.values_mut() {
            if l.session_id == sid && ids.contains(&l.id) {
                l.expires_at = now + LEASE_TTL;
            }
        }
        Ok(())
    }
}
