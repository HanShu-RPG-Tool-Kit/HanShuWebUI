//! History restoration is a checked new transaction, never a rewind of service state.
use super::*;
use crate::{FileOperationKind, FileOperationRequest, ResourceRelationKind, Role};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryRestoreSelection {
    #[ts(type = "number")]
    pub sequence: u64,
    pub paths: Option<Vec<String>>,
    pub skin_entry_id: Option<String>,
    #[serde(default)]
    pub include_related: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryRestoreRequest {
    #[ts(type = "number")]
    pub sequence: u64,
    pub paths: Option<Vec<String>>,
    pub skin_entry_id: Option<String>,
    pub include_related: bool,
    pub expected_head: String,
}
impl HistoryRestoreRequest {
    fn selection(&self) -> HistoryRestoreSelection {
        HistoryRestoreSelection {
            sequence: self.sequence,
            paths: self.paths.clone(),
            skin_entry_id: self.skin_entry_id.clone(),
            include_related: self.include_related,
        }
    }
}
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRestoreChange {
    pub path: String,
    pub action: String,
    pub before_version: Option<String>,
    pub after_version: Option<String>,
}
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRestorePlan {
    pub request: HistoryRestoreRequest,
    pub changes: Vec<HistoryRestoreChange>,
    pub lease_paths: Vec<String>,
    pub warnings: Vec<String>,
}

fn fingerprint(tree: &Tree) -> String {
    hex_digest(
        &serde_json::to_vec(
            &tree
                .iter()
                .map(|(path, value)| (path, value.as_ref().map(|bytes| hex_digest(bytes))))
                .collect::<Vec<_>>(),
        )
        .unwrap(),
    )
}
fn protected_root(path: &str) -> bool {
    matches!(
        path,
        "project.json" | "src" | "meta" | "assets" | ".hanshu/skinmanager"
    )
}
fn changes_between(current: &Tree, target: &Tree) -> Vec<FileChange> {
    let mut removed = Vec::new();
    let mut writes = Vec::new();
    for path in current.keys().chain(target.keys()).collect::<BTreeSet<_>>() {
        if current.get(path) == target.get(path) {
            continue;
        }
        let before = current.get(path);
        let after = target.get(path);
        if before.is_some()
            && (after.is_none() || before.unwrap().is_some() != after.unwrap().is_some())
            && !protected_root(path)
        {
            removed.push(FileChange {
                op: "remove".into(),
                path: path.clone(),
                version: version(current, path),
                content: None,
                destination: None,
                destination_version: None,
                lease_id: String::new(),
            });
        }
        if let Some(bytes) = after {
            writes.push(FileChange {
                op: if bytes.is_some() { "write" } else { "mkdir" }.into(),
                path: path.clone(),
                version: version(current, path),
                content: bytes.as_ref().map(|bytes| STANDARD.encode(bytes)),
                destination: None,
                destination_version: None,
                lease_id: String::new(),
            });
        }
    }
    // Removing descendants explicitly is unnecessary, and can clash with later recreation.
    removed.sort_by_key(|change| change.path.len());
    let mut changes: Vec<FileChange> = Vec::new();
    for change in removed {
        if !changes
            .iter()
            .any(|parent| nested(&parent.path, &change.path))
        {
            changes.push(change);
        }
    }
    writes.sort_by(|a, b| {
        (a.op != "mkdir")
            .cmp(&(b.op != "mkdir"))
            .then(a.path.len().cmp(&b.path.len()))
            .then(a.path.cmp(&b.path))
    });
    // A removed directory may contain unchanged descendants which must be recreated.
    for removal in &changes {
        for (path, bytes) in target
            .iter()
            .filter(|(path, _)| nested(&removal.path, path))
        {
            if !writes.iter().any(|change| change.path == *path) {
                writes.push(FileChange {
                    op: if bytes.is_some() { "write" } else { "mkdir" }.into(),
                    path: path.clone(),
                    version: version(current, path),
                    content: bytes.as_ref().map(|bytes| STANDARD.encode(bytes)),
                    destination: None,
                    destination_version: None,
                    lease_id: String::new(),
                });
            }
        }
    }
    changes.extend(writes);
    changes
}

impl Engine {
    fn prepare_history_restore(
        &self,
        sid: &str,
        selection: HistoryRestoreSelection,
    ) -> Result<(HistoryRestorePlan, Vec<FileChange>)> {
        self.role(sid)?;
        if selection
            .paths
            .as_ref()
            .is_none_or(|paths| paths.len() != 1)
        {
            require(
                self.role(sid)? == Role::Owner,
                "forbidden",
                "只有管理者可以恢复整个工程或同时恢复多个资源；编辑者一次可恢复一个资源及其归属资源",
            )?;
        }
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        store.sync_history()?;
        let current = store.scan()?;
        let historical = store.history_tree(selection.sequence)?;
        let mut warnings = Vec::new();
        let mut target = current.clone();
        let mut roots = if let Some(paths) = &selection.paths {
            require(
                !paths.is_empty() && paths.len() <= 4096,
                "invalid",
                "请选择要恢复的资源",
            )?;
            for path in paths {
                path_ok(path)?;
            }
            paths.iter().cloned().collect::<BTreeSet<_>>()
        } else {
            current.keys().chain(historical.keys()).cloned().collect()
        };
        if selection.skin_entry_id.is_some() {
            require(
                selection.paths.as_ref().is_some_and(|paths| {
                    paths.len() == 1 && paths[0] == crate::skin_patch::LIBRARY_PATH
                }),
                "invalid",
                "条目恢复只能选择皮肤库",
            )?;
        } else {
            if selection.include_related {
                for relation in crate::resource_relations::resolve(&current)
                    .into_iter()
                    .chain(crate::resource_relations::resolve(&historical))
                {
                    if relation.kind == ResourceRelationKind::Ownership
                        && roots.iter().any(|root| nested(root, &relation.from))
                    {
                        roots.insert(relation.to);
                    }
                }
            }
            for path in current
                .keys()
                .chain(historical.keys())
                .collect::<BTreeSet<_>>()
            {
                if roots.iter().any(|root| nested(root, path)) {
                    if let Some(bytes) = historical.get(path) {
                        target.insert(path.clone(), bytes.clone());
                    } else if !protected_root(path) {
                        target.remove(path);
                    }
                }
            }
        }
        let library = crate::skin_patch::LIBRARY_PATH;
        if selection.skin_entry_id.is_some() || target.get(library) != current.get(library) {
            let revision_floor = store.history_skin_revision_floor()?;
            if let Some(Some(bytes)) = historical.get(library) {
                let restored = crate::skin_commands::restore_history_library(
                    current.get(library).and_then(Option::as_deref),
                    bytes,
                    selection.skin_entry_id.as_deref(),
                    revision_floor,
                )?;
                target.insert(library.into(), Some(restored));
            } else if let Some(entry_id) = &selection.skin_entry_id {
                let empty = br#"{"schemaVersion":5,"revision":1,"folders":[],"entries":[]}"#;
                let restored = crate::skin_commands::restore_history_library(
                    current.get(library).and_then(Option::as_deref),
                    empty,
                    Some(entry_id),
                    revision_floor,
                )?;
                target.insert(library.into(), Some(restored));
            }
            // Historical objects remain addressable even after live-library GC.
            if let Some(Some(bytes)) = target.get(library) {
                let value: Value = serde_json::from_slice(bytes)
                    .map_err(|_| Error::new("storage", "历史皮肤库损坏"))?;
                for entry in value["entries"]
                    .as_array()
                    .ok_or_else(|| Error::new("storage", "历史皮肤库条目无效"))?
                {
                    let id = entry["skinId"]
                        .as_str()
                        .filter(|id| skin_core::codec::is_valid_skin_id(id))
                        .ok_or_else(|| Error::new("invalid", "历史皮肤身份无效"))?;
                    let path = format!(".hanshu/skinmanager/objects/{}/{id}.skin", &id[..2]);
                    if !target.contains_key(&path) {
                        target.insert(
                            path.clone(),
                            historical.get(&path).cloned().ok_or_else(|| {
                                Error::new("conflict", "历史版本缺少皮肤对象，无法恢复")
                            })?,
                        );
                    }
                }
                for entry in value["entries"].as_array().unwrap() {
                    crate::skin_commands::validate_import_object(entry, &target)?;
                }
            }
        }
        // Keep the project's identity and service roots even when restoring the initial baseline.
        if let Some(manifest) = current.get("project.json") {
            if !historical.contains_key("project.json") {
                target.insert("project.json".into(), manifest.clone());
                warnings.push("目标版本早于工程初始化，保留当前工程清单。".into());
            }
        }
        // Include recreated parent directories in the preview and write set.
        // A live file occupying a parent is a conflict, not implicit deletion.
        for path in target.keys().cloned().collect::<Vec<_>>() {
            let mut path = path.as_str();
            while let Some((parent, _)) = path.rsplit_once('/') {
                if parent == ".hanshu" {
                    break;
                }
                require(
                    !target.get(parent).is_some_and(Option::is_some),
                    "conflict",
                    "恢复所需目录被其他文件占用，请扩大恢复范围并重新预览",
                )?;
                target.entry(parent.into()).or_insert(None);
                path = parent;
            }
        }
        let mut changes = changes_between(&current, &target);
        if changes.is_empty() {
            // A checked no-op still returns a durable receipt, without creating content history.
            let path = current
                .keys()
                .next()
                .ok_or_else(|| Error::new("invalid", "工程为空，无需恢复"))?;
            changes.push(FileChange {
                op: "check".into(),
                path: path.clone(),
                version: version(&current, path),
                content: None,
                destination: None,
                destination_version: None,
                lease_id: String::new(),
            });
        }
        // Deleting a source may require its owned assets, even if the user did not select them.
        let requests = changes
            .iter()
            .map(|change| {
                Ok(FileOperationRequest {
                    op: FileOperationKind::parse(&change.op)?,
                    path: change.path.clone(),
                    destination: None,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let policy = crate::resource_policy::plan_restore(&current, store.revision, &requests)?;
        for operation in &policy.operations {
            if !changes.iter().any(|change| {
                change.path == operation.path
                    && FileOperationKind::parse(&change.op).ok() == Some(operation.op)
            }) {
                require(
                    operation.op == FileOperationKind::Remove,
                    "invalid",
                    "恢复需要额外的结构操作",
                )?;
                require(
                    !target.contains_key(&operation.path),
                    "conflict",
                    "恢复源文件将移除仍需保留的关联资源，请选择包含关联资源后重新预览",
                )?;
                changes.push(FileChange {
                    op: "remove".into(),
                    path: operation.path.clone(),
                    version: operation.version.clone(),
                    content: None,
                    destination: None,
                    destination_version: None,
                    lease_id: String::new(),
                });
                warnings.push(format!("按资源删除规则一并处理：{}", operation.path));
            }
        }
        require(
            changes.len() <= 4096,
            "invalid",
            "恢复范围超过单次事务上限，请缩小范围",
        )?;
        let display = current
            .keys()
            .chain(target.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|path| current.get(*path) != target.get(*path))
            .map(|path| HistoryRestoreChange {
                path: path.clone(),
                action: target
                    .get(path)
                    .map_or(
                        "remove",
                        |value| if value.is_some() { "write" } else { "mkdir" },
                    )
                    .into(),
                before_version: version(&current, path),
                after_version: version(&target, path),
            })
            .collect();
        let plan = HistoryRestorePlan {
            request: HistoryRestoreRequest {
                sequence: selection.sequence,
                paths: selection.paths,
                skin_entry_id: selection.skin_entry_id,
                include_related: selection.include_related,
                expected_head: fingerprint(&current),
            },
            changes: display,
            lease_paths: policy.lease_paths,
            warnings,
        };
        Ok((plan, changes))
    }
    pub fn plan_history_restore(
        &self,
        sid: &str,
        selection: HistoryRestoreSelection,
    ) -> Result<HistoryRestorePlan> {
        self.prepare_history_restore(sid, selection)
            .map(|(plan, _)| plan)
    }
    pub(super) fn expand_history_restore(
        &mut self,
        sid: &str,
        input: &[FileChange],
        now: u64,
    ) -> Result<(Vec<FileChange>, Vec<Lease>)> {
        self.writer(sid)?;
        require(
            input.len() == 1
                && input[0].op == "history-restore"
                && input[0].path == "project.json"
                && input[0].destination.is_none()
                && input[0].destination_version.is_none(),
            "invalid",
            "历史恢复不能与其他操作混合",
        )?;
        let bytes = STANDARD
            .decode(
                input[0]
                    .content
                    .as_deref()
                    .ok_or_else(|| Error::new("invalid", "缺少历史恢复请求"))?,
            )
            .map_err(|_| Error::new("invalid", "历史恢复编码无效"))?;
        require(bytes.len() <= 256 * 1024, "invalid", "历史恢复请求过大")?;
        let request: HistoryRestoreRequest = serde_json::from_slice(&bytes)
            .map_err(|_| Error::new("invalid", "历史恢复请求无效"))?;
        let (plan, mut changes) = self.prepare_history_restore(sid, request.selection())?;
        require(
            plan.request.expected_head == request.expected_head,
            "conflict",
            "恢复预览之后工程已有变化，请重新预览后确认",
        )?;
        let existing = self
            .leases
            .values()
            .map(|lease| lease.id.clone())
            .collect::<BTreeSet<_>>();
        let acquired = self.acquire_files(sid, &plan.lease_paths, false, now)?;
        for change in &mut changes {
            change.lease_id = acquired
                .iter()
                .find(|lease| lease.resource_id == format!("file:{}", change.path))
                .ok_or_else(|| Error::new("locked", "恢复缺少写权"))?
                .id
                .clone();
        }
        Ok((
            changes,
            acquired
                .into_iter()
                .filter(|lease| !existing.contains(&lease.id))
                .collect(),
        ))
    }
}
