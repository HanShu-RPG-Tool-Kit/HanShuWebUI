//! Per-operation policy. Relation facts remain independent from lock and cascade decisions.
use crate::{
    files::{nested, path_ok, version, Tree},
    require, resource_relations as relations, Error, ResourceRelation, ResourceRelationKind,
    Result,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum FileOperationKind {
    #[serde(rename = "progress-command")]
    ProgressCommand,
    #[serde(rename = "history-restore")]
    HistoryRestore,
    Write,
    #[serde(rename = "skin-entry-patch")]
    SkinEntryPatch,
    #[serde(rename = "skin-library-command")]
    SkinLibraryCommand,
    Mkdir,
    Check,
    Move,
    Remove,
}
impl FileOperationKind {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "progress-command" => Self::ProgressCommand,
            "history-restore" => Self::HistoryRestore,
            "write" => Self::Write,
            "skin-entry-patch" => Self::SkinEntryPatch,
            "skin-library-command" => Self::SkinLibraryCommand,
            "mkdir" => Self::Mkdir,
            "check" => Self::Check,
            "move" => Self::Move,
            "remove" => Self::Remove,
            _ => return Err(Error::new("invalid", "未知工程操作")),
        })
    }
    fn structural(self) -> bool {
        matches!(self, Self::Move | Self::Remove)
    }
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileOperationRequest {
    pub op: FileOperationKind,
    pub path: String,
    pub destination: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFileOperation {
    pub op: FileOperationKind,
    pub path: String,
    pub destination: Option<String>,
    pub version: Option<String>,
    pub destination_version: Option<String>,
    pub origin_path: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileEditAuthority {
    pub path: String,
    pub authority_path: String,
    pub source_kind: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceOperationPlan {
    #[ts(type = "number")]
    pub revision: u64,
    pub operations: Vec<PlannedFileOperation>,
    pub lease_paths: Vec<String>,
    pub authorities: Vec<FileEditAuthority>,
    pub relations: Vec<ResourceRelation>,
}

/// First policy version intentionally retains source-wide editing authority for owned
/// language/audio. Replacing this rule later does not change the ownership resolver.
pub(crate) fn edit_authority(path: &str, tree: &Tree) -> FileEditAuthority {
    let owner = relations::asset_owner(path, tree)
        .map(|(source, _, _)| source)
        .or_else(|| relations::source(path));
    FileEditAuthority {
        path: path.into(),
        authority_path: owner
            .as_ref()
            .map_or_else(|| path.into(), |source| source.path.clone()),
        source_kind: owner.map(|source| source.kind),
    }
}

fn covered(op: &PlannedFileOperation, ancestor: &PlannedFileOperation) -> bool {
    if op.op != ancestor.op {
        return false;
    }
    if op.path == ancestor.path {
        return op.destination == ancestor.destination;
    }
    if !ancestor.op.structural() || !nested(&ancestor.path, &op.path) {
        return false;
    }
    match (&ancestor.destination, &op.destination) {
        (None, None) => true,
        (Some(to), Some(target)) => target == &format!("{to}{}", &op.path[ancestor.path.len()..]),
        _ => false,
    }
}

pub(crate) fn plan(
    tree: &Tree,
    revision: u64,
    requests: &[FileOperationRequest],
) -> Result<ResourceOperationPlan> {
    plan_inner(tree, revision, requests, false)
}

/// Only the server's history planner can request a checked type replacement.
/// The ordinary public planner never accepts remove-and-recreate combinations.
pub(crate) fn plan_restore(
    tree: &Tree,
    revision: u64,
    requests: &[FileOperationRequest],
) -> Result<ResourceOperationPlan> {
    plan_inner(tree, revision, requests, true)
}

fn plan_inner(
    tree: &Tree,
    revision: u64,
    requests: &[FileOperationRequest],
    trusted_restore: bool,
) -> Result<ResourceOperationPlan> {
    require(
        !requests.is_empty() && requests.len() <= 4096,
        "invalid",
        "资源操作计划为空或过大",
    )?;
    let mut context = tree.clone();
    for request in requests {
        require(
            !matches!(
                request.op,
                FileOperationKind::HistoryRestore | FileOperationKind::ProgressCommand
            ),
            "invalid",
            "业务命令须通过专用受校验事务提交",
        )?;
        path_ok(&request.path)?;
        if matches!(
            request.op,
            FileOperationKind::SkinEntryPatch | FileOperationKind::SkinLibraryCommand
        ) {
            require(
                request.path == crate::skin_patch::LIBRARY_PATH,
                "invalid",
                "皮肤业务操作只能作用于皮肤库索引",
            )?;
            require(
                requests
                    .iter()
                    .filter(|other| {
                        other.op != FileOperationKind::Check
                            && (nested(&request.path, &other.path)
                                || nested(&other.path, &request.path))
                    })
                    .count()
                    == 1,
                "invalid",
                "一次事务只能包含一个皮肤业务操作，且不能同时替换或删除索引",
            )?;
        }
        if request.op == FileOperationKind::Write {
            context
                .entry(request.path.clone())
                .or_insert_with(|| Some(Vec::new()));
        }
        if request.op == FileOperationKind::Mkdir {
            context.entry(request.path.clone()).or_insert(None);
        }
        require(
            (request.op == FileOperationKind::Move) == request.destination.is_some(),
            "invalid",
            "只有移动操作需要目标路径",
        )?;
        if let Some(destination) = &request.destination {
            path_ok(destination)?;
        }
        if request.op.structural() {
            require(
                request.path != "project.json"
                    && !["src", "meta", "assets", ".hanshu/skinmanager"]
                        .contains(&request.path.as_str()),
                "forbidden",
                "不能移动或删除工程清单或资源根目录",
            )?;
        }
        if let Some(destination) = &request.destination {
            require(
                tree.contains_key(&request.path),
                "invalid",
                "移动源不存在（文件可能尚未保存到工程，请先保存再改名）",
            )?;
            require(
                destination != "project.json" && !nested(&request.path, destination),
                "invalid",
                "移动目标无效",
            )?;
            require(
                !tree.contains_key(destination),
                "conflict",
                "移动目标已经存在",
            )?;
            for (path, _) in tree
                .iter()
                .filter(|(path, bytes)| bytes.is_some() && nested(&request.path, path))
            {
                if relations::source(path).is_some() {
                    context.insert(
                        format!("{destination}{}", &path[request.path.len()..]),
                        Some(Vec::new()),
                    );
                }
            }
        }
    }
    // Adding a more specific source must not silently reassign pre-existing voice clips
    // away from the old source's write authority. Reparenting needs an explicit future policy.
    for (path, bytes) in tree {
        if bytes.is_none() {
            continue;
        }
        if let (
            Some((old, crate::ResourceRelationRole::Voice, _)),
            Some((next, crate::ResourceRelationRole::Voice, _)),
        ) = (
            relations::asset_owner(path, tree),
            relations::asset_owner(path, &context),
        ) {
            require(
                old.path == next.path,
                "invalid",
                "新增或移动源文件会改变现有配音资源的归属，请先明确整理配音资源",
            )?;
        }
    }
    let mut facts = relations::resolve(&context)
        .into_iter()
        .collect::<BTreeSet<_>>();
    for request in requests.iter().filter(|request| {
        matches!(
            request.op,
            FileOperationKind::Write | FileOperationKind::Mkdir
        )
    }) {
        if let Some((owner, role, to)) = relations::asset_owner(&request.path, &context) {
            facts.insert(ResourceRelation {
                kind: ResourceRelationKind::Ownership,
                role,
                from: owner.path,
                to,
            });
        }
    }
    let facts = facts.into_iter().collect::<Vec<_>>();
    let mut operations: Vec<PlannedFileOperation> = Vec::new();
    for request in requests {
        let operation = |path: String, destination: Option<String>| PlannedFileOperation {
            op: request.op,
            version: version(tree, &path),
            destination_version: destination.as_deref().and_then(|p| version(tree, p)),
            path,
            destination,
            origin_path: request.path.clone(),
        };
        operations.push(operation(request.path.clone(), request.destination.clone()));
        if !request.op.structural() {
            continue;
        }
        // Source descendants are evaluated even when no dependent assets currently exist,
        // so a source cannot silently become a different resource type during a move.
        for (path, bytes) in tree.iter().filter(|(path, _)| nested(&request.path, path)) {
            if bytes.is_none() {
                continue;
            }
            if let Some(destination) = &request.destination {
                let target = format!("{destination}{}", &path[request.path.len()..]);
                let old = relations::source(path);
                let next = relations::source(&target);
                if old.is_some() || next.is_some() {
                    require(
                        old.as_ref()
                            .zip(next.as_ref())
                            .is_some_and(|(old, next)| old.kind == next.kind),
                        "invalid",
                        "源文件移动必须保留资源类型及其目录约定；导入请使用受校验的写入操作",
                    )?;
                }
                require(
                    !target.to_ascii_lowercase().ends_with(".quest")
                        || path.to_ascii_lowercase().ends_with(".quest"),
                    "invalid",
                    "不能通过改名把普通文件转换为进度文档",
                )?;
            }
        }
        for relation in facts.iter().filter(|relation| {
            relation.kind == ResourceRelationKind::Ownership
                && nested(&request.path, &relation.from)
        }) {
            if !tree.contains_key(&relation.to) {
                continue;
            }
            let destination = if let Some(destination) = &request.destination {
                let next_source = relations::source(&format!(
                    "{destination}{}",
                    &relation.from[request.path.len()..]
                ))
                .ok_or_else(|| Error::new("invalid", "关联资源的移动目标无效"))?;
                relations::relocated_owned(relation, &next_source)
            } else {
                None
            };
            if destination.as_deref() == Some(relation.to.as_str()) {
                continue;
            }
            if let Some(target) = &destination {
                require(
                    !nested(&relation.to, target),
                    "invalid",
                    "关联目录不能移动到自身内部",
                )?;
            }
            // voice/a may physically contain voice/a/b even though a.hs and a/b.hs
            // are distinct sources. Cascading a's entire folder must not erase b's data.
            // It is safe only when b participates in the same structural transformation.
            for other in facts.iter().filter(|other| {
                other.kind == ResourceRelationKind::Ownership
                    && other.from != relation.from
                    && nested(&relation.to, &other.to)
            }) {
                let compatible = requests.iter().any(|candidate| {
                    if candidate.op != request.op || !nested(&candidate.path, &other.from) {
                        return false;
                    }
                    match (&destination, &candidate.destination) {
                        (None, None) => true,
                        (Some(parent_target), Some(source_target)) => {
                            let next =
                                format!("{source_target}{}", &other.from[candidate.path.len()..]);
                            relations::source(&next)
                                .and_then(|source| relations::relocated_owned(other, &source))
                                .is_some_and(|target| {
                                    target
                                        == format!(
                                            "{parent_target}{}",
                                            &other.to[relation.to.len()..]
                                        )
                                })
                        }
                        _ => false,
                    }
                });
                require(
                    compatible,
                    "invalid",
                    "关联目录还包含其他源文件的资源，不能单独级联移动或删除",
                )?;
            }
            if let Some(destination) = &destination {
                require(
                    !tree.contains_key(destination),
                    "conflict",
                    "关联资源的目标已经存在",
                )?;
            }
            operations.push(operation(relation.to.clone(), destination));
        }
    }
    // Overlapping selected directories/sources produce one structural operation. Conflicting
    // requests remain visible and are rejected rather than depending on accidental ordering.
    let mut compact: Vec<PlannedFileOperation> = Vec::new();
    for operation in operations {
        if compact.iter().any(|other| covered(&operation, other)) {
            continue;
        }
        compact.retain(|other| !covered(other, &operation));
        require(
            !compact.iter().any(|other| {
                let replacement = trusted_restore
                    && other.op == FileOperationKind::Remove
                    && match operation.op {
                        FileOperationKind::Write => matches!(tree.get(&operation.path), Some(None)),
                        FileOperationKind::Mkdir => {
                            matches!(tree.get(&operation.path), Some(Some(_)))
                        }
                        _ => false,
                    };
                other.path == operation.path
                    && (other.op.structural() || operation.op.structural())
                    && !replacement
            }),
            "invalid",
            "同一资源包含冲突的结构操作",
        )?;
        compact.push(operation);
    }
    require(
        compact.len() <= 4096,
        "invalid",
        "关联资源展开后超过事务上限",
    )?;
    let mut lease_paths = BTreeSet::new();
    let mut authorities = BTreeMap::new();
    let mut relevant = BTreeSet::new();
    for operation in &compact {
        for path in std::iter::once(operation.path.as_str()).chain(operation.destination.as_deref())
        {
            path_ok(path)?;
            lease_paths.insert(path.to_owned());
            let authority = edit_authority(path, &context);
            lease_paths.insert(authority.authority_path.clone());
            authorities.insert(path.to_owned(), authority);
            for relation in facts
                .iter()
                .filter(|relation| relations::related_to(relation, path))
            {
                relevant.insert(relation.clone());
            }
        }
        if matches!(tree.get(&operation.path), Some(None)) {
            // Directory mutations must satisfy each contained asset's editing policy too.
            for path in tree.keys().filter(|path| nested(&operation.path, path)) {
                let authority = edit_authority(path, &context);
                if authority.authority_path != *path {
                    lease_paths.insert(authority.authority_path.clone());
                }
                authorities.insert(path.clone(), authority);
                if let Some(destination) = &operation.destination {
                    let target = format!("{destination}{}", &path[operation.path.len()..]);
                    let authority = edit_authority(&target, &context);
                    if authority.authority_path != target {
                        lease_paths.insert(authority.authority_path.clone());
                    }
                    authorities.insert(target, authority);
                }
            }
        }
    }
    require(
        lease_paths.len() <= 4096,
        "invalid",
        "操作计划需要的写权超过单次请求上限",
    )?;
    Ok(ResourceOperationPlan {
        revision,
        operations: compact,
        lease_paths: lease_paths.into_iter().collect(),
        authorities: authorities.into_values().collect(),
        relations: relevant.into_iter().collect(),
    })
}
