//! Skin business commands share file leases, the durable journal and immutable receipts.
//! Their read sets describe the affected entries/folders, never an obsolete whole index.
use crate::{files::Tree, require, skin_patch, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use skin_core::{
    codec,
    storage::{normalize_custom_id, normalize_name, normalize_tag_list, now_iso_public},
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Folder {
    folder_id: String,
    name: String,
    parent_id: Option<String>,
    sort_order: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryRef {
    entry_id: String,
    revision: u64,
}

#[derive(Deserialize)]
#[serde(
    tag = "command",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Command {
    EnsureLibrary {},
    ImportEntry {
        entry: Value,
    },
    BatchPatch {
        expected_entries: Vec<EntryRef>,
        changes: Map<String, Value>,
    },
    DeleteEntries {
        expected_entries: Vec<EntryRef>,
    },
    CreateFolder {
        folder_id: String,
        name: String,
        parent_id: Option<String>,
    },
    PatchFolder {
        expected_folder: Folder,
        changes: Map<String, Value>,
        expected_siblings: Option<Vec<Folder>>,
    },
    DeleteFolder {
        expected_folder: Folder,
    },
    RenameTag {
        from: String,
        to: String,
        expected_entries: Vec<EntryRef>,
    },
    DeleteTag {
        name: String,
        expected_entries: Vec<EntryRef>,
    },
    DeleteFolderEntries {
        folder_id: String,
        expected_folders: Vec<Folder>,
        expected_entries: Vec<EntryRef>,
    },
}

fn invalid(message: &str) -> Error {
    Error::new("invalid", message)
}
fn identity(value: &str) -> Result<()> {
    require(
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        "invalid",
        "皮肤或文件夹身份无效",
    )
}
fn folder_name(value: &str) -> Result<String> {
    let name = normalize_name(value);
    require(
        !name.is_empty() && name.chars().count() <= 256,
        "invalid",
        "文件夹名称不能为空或超过 256 字符",
    )?;
    Ok(name)
}
fn tag_name(value: &str) -> Result<String> {
    require(value.chars().count() <= 512, "invalid", "标签名称过长")?;
    normalize_tag_list(vec![value.to_owned()])
        .into_iter()
        .next()
        .ok_or_else(|| invalid("标签名称不能为空"))
}
fn folders(library: &Value) -> Result<Vec<Folder>> {
    serde_json::from_value(library["folders"].clone())
        .map_err(|_| Error::new("storage", "皮肤文件夹结构无效"))
}
fn entries(library: &Value) -> Result<&Vec<Value>> {
    library["entries"]
        .as_array()
        .ok_or_else(|| Error::new("storage", "皮肤条目列表无效"))
}
fn validate_folders(values: &[Folder]) -> Result<()> {
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for f in values {
        identity(&f.folder_id)?;
        require(ids.insert(f.folder_id.clone()), "invalid", "文件夹身份重复")?;
        require(
            f.sort_order >= 0 && f.sort_order <= 9_007_199_254_740_991,
            "invalid",
            "文件夹排序值无效",
        )?;
        require(
            names.insert((f.parent_id.clone(), folder_name(&f.name)?)),
            "conflict",
            "同级文件夹名称已被使用",
        )?;
    }
    for f in values {
        let mut visited = BTreeSet::from([f.folder_id.as_str()]);
        let mut parent = f.parent_id.as_deref();
        while let Some(id) = parent {
            require(
                visited.insert(id),
                "invalid",
                "不能把文件夹移动到自身或子文件夹中",
            )?;
            let found = values
                .iter()
                .find(|candidate| candidate.folder_id == id)
                .ok_or_else(|| Error::new("conflict", "目标父文件夹已不存在"))?;
            parent = found.parent_id.as_deref();
        }
    }
    Ok(())
}
fn read_library(before: Option<&[u8]>) -> Result<Value> {
    let bytes = before.ok_or_else(|| Error::new("conflict", "皮肤库索引不存在或已被删除"))?;
    let library: Value =
        serde_json::from_slice(bytes).map_err(|_| Error::new("storage", "皮肤库索引损坏"))?;
    require(
        library["schemaVersion"] == 5,
        "storage",
        "仅支持 schema 5 皮肤库，请先迁移旧版索引",
    )?;
    skin_patch::revision(&library["revision"])?;
    validate_folders(&folders(&library)?)?;
    let mut ids = BTreeSet::new();
    for entry in entries(&library)? {
        let id = entry["entryId"]
            .as_str()
            .ok_or_else(|| Error::new("storage", "皮肤条目身份无效"))?;
        identity(id)?;
        require(ids.insert(id), "storage", "皮肤条目身份重复")?;
        skin_patch::revision(&entry["revision"])?;
    }
    Ok(library)
}
fn check_entries(
    library: &Value,
    expected: &[EntryRef],
    scope: Option<&BTreeSet<String>>,
) -> Result<BTreeSet<String>> {
    require(
        expected.len() <= 4096,
        "invalid",
        "一次操作最多涉及 4096 条皮肤",
    )?;
    let mut ids = BTreeSet::new();
    for wanted in expected {
        identity(&wanted.entry_id)?;
        require(
            ids.insert(wanted.entry_id.clone()),
            "invalid",
            "预期条目列表包含重复身份",
        )?;
        let entry = entries(library)?
            .iter()
            .find(|e| e["entryId"] == wanted.entry_id)
            .ok_or_else(|| Error::new("conflict", "选中的皮肤已被删除，请刷新后重新操作"))?;
        require(
            wanted.revision > 0 && entry["revision"].as_u64() == Some(wanted.revision),
            "conflict",
            "选中的皮肤已被修改，整批操作未执行",
        )?;
    }
    if let Some(scope) = scope {
        require(
            ids == *scope,
            "conflict",
            "操作范围中的皮肤已增加、移走或删除，请确认最新范围后重试",
        )?;
    }
    Ok(ids)
}
fn check_folder(current: &[Folder], expected: &Folder) -> Result<usize> {
    let index = current
        .iter()
        .position(|f| f.folder_id == expected.folder_id)
        .ok_or_else(|| Error::new("conflict", "文件夹已被删除"))?;
    require(
        current[index] == *expected,
        "conflict",
        "文件夹已被其他客户端修改",
    )?;
    Ok(index)
}
fn folder_map(values: &[Folder]) -> Result<BTreeMap<String, Folder>> {
    let mut result = BTreeMap::new();
    for f in values {
        require(
            result.insert(f.folder_id.clone(), f.clone()).is_none(),
            "invalid",
            "预期文件夹列表包含重复身份",
        )?;
    }
    Ok(result)
}
fn descendants(values: &[Folder], id: &str) -> Result<BTreeSet<String>> {
    require(
        values.iter().any(|f| f.folder_id == id),
        "conflict",
        "文件夹已被删除",
    )?;
    let mut scope = BTreeSet::from([id.to_owned()]);
    loop {
        let before = scope.len();
        for f in values {
            if f.parent_id
                .as_ref()
                .is_some_and(|parent| scope.contains(parent))
            {
                scope.insert(f.folder_id.clone());
            }
        }
        if scope.len() == before {
            return Ok(scope);
        }
    }
}
fn entry_scope(library: &Value, matches: impl Fn(&Value) -> bool) -> Result<BTreeSet<String>> {
    Ok(entries(library)?
        .iter()
        .filter(|entry| matches(entry))
        .map(|e| e["entryId"].as_str().unwrap().to_owned())
        .collect())
}
fn remove_entries(library: &mut Value, ids: &BTreeSet<String>) {
    library["entries"]
        .as_array_mut()
        .unwrap()
        .retain(|e| !ids.contains(e["entryId"].as_str().unwrap()));
}
fn patch_entries(
    library: &mut Value,
    expected: &[EntryRef],
    changes: &Map<String, Value>,
) -> Result<Vec<Value>> {
    let mut results = Vec::new();
    for wanted in expected {
        results.push(skin_patch::patch_entry(
            library,
            &wanted.entry_id,
            wanted.revision,
            changes,
        )?);
    }
    Ok(results)
}
fn import_entry(library: &Value, mut entry: Value) -> Result<Value> {
    const FIELDS: &[&str] = &[
        "entryId",
        "skinId",
        "name",
        "active",
        "tags",
        "folderId",
        "favorite",
        "model",
        "textureWidth",
        "textureHeight",
        "source",
        "provenance",
        "license",
        "note",
        "customId",
        "createdAt",
        "updatedAt",
        "revision",
    ];
    let fields = entry
        .as_object()
        .ok_or_else(|| invalid("导入条目必须为对象"))?;
    require(
        fields.len() == FIELDS.len() && fields.keys().all(|key| FIELDS.contains(&key.as_str())),
        "invalid",
        "导入条目字段缺失或包含未知字段",
    )?;
    identity(skin_patch::text(&entry["entryId"], 256)?)?;
    require(
        !entries(library)?
            .iter()
            .any(|e| e["entryId"] == entry["entryId"]),
        "conflict",
        "导入条目身份已存在",
    )?;
    require(
        codec::is_valid_skin_id(skin_patch::text(&entry["skinId"], 64)?),
        "invalid",
        "皮肤对象身份无效",
    )?;
    let name = normalize_name(skin_patch::text(&entry["name"], 256)?);
    require(!name.is_empty(), "invalid", "皮肤名称不能为空")?;
    entry["name"] = json!(name);
    for field in ["favorite", "active"] {
        require(
            entry[field].is_boolean(),
            "invalid",
            "皮肤开关字段必须为布尔值",
        )?;
    }
    require(
        entry["model"]
            .as_str()
            .and_then(codec::SkinModel::parse)
            .is_some(),
        "invalid",
        "皮肤模型必须为 classic 或 slim",
    )?;
    entry["tags"] = json!(skin_patch::tags(&entry["tags"])?);
    let folder = &entry["folderId"];
    if !folder.is_null() {
        let id = skin_patch::text(folder, 256)?;
        require(
            folders(library)?.iter().any(|f| f.folder_id == id),
            "conflict",
            "导入目标文件夹已不存在",
        )?;
    }
    for field in ["textureWidth", "textureHeight"] {
        require(
            entry[field].as_u64().is_some_and(|v| v > 0 && v <= 1024),
            "invalid",
            "纹理尺寸无效",
        )?;
    }
    skin_patch::text(&entry["note"], 16_384)?;
    entry["license"] = skin_patch::metadata(&entry["license"], true)?;
    entry["provenance"] = skin_patch::metadata(&entry["provenance"], false)?;
    let id = normalize_custom_id(if entry["customId"].is_null() {
        None
    } else {
        Some(skin_patch::text(&entry["customId"], 1024)?)
    })
    .map_err(|_| invalid("自定义 ID 最长 64 字符"))?;
    if let Some(id) = &id {
        require(
            !entries(library)?.iter().any(|e| e["customId"] == *id),
            "conflict",
            "自定义 ID 已被其他皮肤使用",
        )?;
    }
    entry["customId"] = json!(id);
    let source = entry["source"]
        .as_object()
        .ok_or_else(|| invalid("导入来源必须为对象"))?;
    let (allowed, required): (&[&str], &[&str]) = match source.get("kind").and_then(Value::as_str) {
        Some("png-file" | "skin-file") => (&["kind", "fileName"], &[]),
        Some("png-url") => (&["kind", "url"], &["url"]),
        Some("player-name") => (&["kind", "playerName", "uuid"], &["playerName"]),
        Some("skin-code") => (&["kind"], &[]),
        _ => return Err(invalid("导入来源种类无效")),
    };
    require(
        source.keys().all(|key| allowed.contains(&key.as_str()))
            && required.iter().all(|key| source.contains_key(*key)),
        "invalid",
        "导入来源字段无效",
    )?;
    for value in source.values() {
        skin_patch::text(value, 8192)?;
    }
    let now = now_iso_public();
    entry["createdAt"] = json!(now);
    entry["updatedAt"] = entry["createdAt"].clone();
    entry["revision"] = json!(1);
    Ok(entry)
}

pub(crate) fn apply(before: Option<&[u8]>, bytes: &[u8]) -> Result<(Vec<u8>, Value, Vec<Value>)> {
    require(
        bytes.len() <= 2 * 1024 * 1024,
        "invalid",
        "皮肤业务命令超过 2 MiB",
    )?;
    let command: Command =
        serde_json::from_slice(bytes).map_err(|_| invalid("皮肤业务命令结构无效"))?;
    let kind: Value = serde_json::from_slice::<Value>(bytes).unwrap()["command"].clone();
    if matches!(command, Command::EnsureLibrary {}) {
        let created = before.is_none();
        let library = if created {
            json!({"schemaVersion":5,"revision":1,"folders":[],"entries":[]})
        } else {
            read_library(before)?
        };
        let encoded = before.map_or_else(
            || serde_json::to_vec_pretty(&library).unwrap(),
            <[u8]>::to_vec,
        );
        return Ok((
            encoded,
            json!({"command":kind,"result":{"created":created,"revision":library["revision"]}}),
            vec![],
        ));
    }
    let mut library = read_library(before)?;
    let next_revision = skin_patch::revision(&library["revision"])? + 1;
    let mut affected = Vec::new();
    let mut result = match command {
        Command::EnsureLibrary {} => unreachable!(),
        Command::ImportEntry { entry } => {
            let entry = import_entry(&library, entry)?;
            library["entries"]
                .as_array_mut()
                .unwrap()
                .push(entry.clone());
            affected.push(entry.clone());
            json!({"entry":entry})
        }
        Command::BatchPatch {
            expected_entries,
            changes,
        } => {
            require(
                !expected_entries.is_empty()
                    && !changes.is_empty()
                    && changes.keys().all(|key| {
                        ["addTags", "removeTags", "folderId", "active"].contains(&key.as_str())
                    }),
                "invalid",
                "批量修改为空或包含未知字段",
            )?;
            check_entries(&library, &expected_entries, None)?;
            affected = patch_entries(&mut library, &expected_entries, &changes)?;
            json!({"updated":affected.len(),"entries":affected})
        }
        Command::DeleteEntries { expected_entries } => {
            require(
                !expected_entries.is_empty(),
                "invalid",
                "请选择要删除的皮肤",
            )?;
            let ids = check_entries(&library, &expected_entries, None)?;
            remove_entries(&mut library, &ids);
            json!({"deleted":ids.len()})
        }
        Command::CreateFolder {
            folder_id,
            name,
            parent_id,
        } => {
            let mut values = folders(&library)?;
            let folder = Folder {
                folder_id,
                name: folder_name(&name)?,
                sort_order: values
                    .iter()
                    .filter(|f| f.parent_id == parent_id)
                    .map(|f| f.sort_order)
                    .max()
                    .map_or(0, |order| order + 1),
                parent_id,
            };
            values.push(folder.clone());
            validate_folders(&values)?;
            library["folders"] = json!(values);
            json!({"folder":folder})
        }
        Command::PatchFolder {
            expected_folder,
            changes,
            expected_siblings,
        } => {
            require(
                !changes.is_empty()
                    && changes.keys().all(|key| {
                        ["name", "parentId", "sortOrder", "sortSiblingsByName"]
                            .contains(&key.as_str())
                    }),
                "invalid",
                "文件夹修改为空或包含未知字段",
            )?;
            let mut values = folders(&library)?;
            let index = check_folder(&values, &expected_folder)?;
            if let Some(v) = changes.get("name") {
                values[index].name = folder_name(skin_patch::text(v, 256)?)?;
            }
            if let Some(v) = changes.get("parentId") {
                values[index].parent_id = if v.is_null() {
                    None
                } else {
                    Some(skin_patch::text(v, 256)?.to_owned())
                };
            }
            if let Some(v) = changes.get("sortOrder") {
                values[index].sort_order =
                    v.as_i64().ok_or_else(|| invalid("文件夹排序必须为整数"))?;
            }
            let sort = changes
                .get("sortSiblingsByName")
                .map(|v| {
                    v.as_bool()
                        .ok_or_else(|| invalid("文件夹排序开关必须为布尔值"))
                })
                .transpose()?
                .unwrap_or(false);
            if sort {
                let wanted =
                    expected_siblings.ok_or_else(|| invalid("排序需要完整同级文件夹快照"))?;
                let target_parent = values[index].parent_id.clone();
                let current: Vec<Folder> = folders(&library)?
                    .into_iter()
                    .filter(|f| f.parent_id == target_parent)
                    .collect();
                require(
                    folder_map(&current)? == folder_map(&wanted)?,
                    "conflict",
                    "同级文件夹已变化，请重新确认排序",
                )?;
                let mut positions: Vec<usize> = (0..values.len())
                    .filter(|i| values[*i].parent_id == target_parent)
                    .collect();
                positions.sort_by(|a, b| {
                    values[*a]
                        .name
                        .cmp(&values[*b].name)
                        .then(values[*a].folder_id.cmp(&values[*b].folder_id))
                });
                for (order, position) in positions.into_iter().enumerate() {
                    values[position].sort_order = order as i64;
                }
            } else {
                require(
                    expected_siblings.is_none(),
                    "invalid",
                    "只有同级排序需要同级文件夹快照",
                )?;
            }
            validate_folders(&values)?;
            let folder = values[index].clone();
            library["folders"] = json!(values);
            json!({"folder":folder})
        }
        Command::DeleteFolder { expected_folder } => {
            let mut values = folders(&library)?;
            let index = check_folder(&values, &expected_folder)?;
            require(
                !values
                    .iter()
                    .any(|f| f.parent_id.as_ref() == Some(&expected_folder.folder_id))
                    && !entries(&library)?
                        .iter()
                        .any(|e| e["folderId"] == expected_folder.folder_id),
                "conflict",
                "只能删除空文件夹，请先移走其中的皮肤和子文件夹",
            )?;
            values.remove(index);
            library["folders"] = json!(values);
            json!({"deleted":true})
        }
        Command::RenameTag {
            from,
            to,
            expected_entries,
        } => {
            let from = tag_name(&from)?;
            let to = tag_name(&to)?;
            let key = from.to_lowercase();
            let scope = entry_scope(&library, |e| {
                e["tags"].as_array().is_some_and(|tags| {
                    tags.iter()
                        .any(|t| t.as_str().is_some_and(|t| t.to_lowercase() == key))
                })
            })?;
            check_entries(&library, &expected_entries, Some(&scope))?;
            for wanted in &expected_entries {
                let entry = entries(&library)?
                    .iter()
                    .find(|e| e["entryId"] == wanted.entry_id)
                    .unwrap();
                let tags = skin_patch::tags(&entry["tags"])?;
                let next = tags
                    .into_iter()
                    .map(|t| {
                        if t.to_lowercase() == key {
                            to.clone()
                        } else {
                            t
                        }
                    })
                    .collect::<Vec<_>>();
                let mut changes = Map::new();
                changes.insert("tags".into(), json!(next));
                affected.extend(patch_entries(
                    &mut library,
                    std::slice::from_ref(wanted),
                    &changes,
                )?);
            }
            json!({"affectedEntries":affected.len()})
        }
        Command::DeleteTag {
            name,
            expected_entries,
        } => {
            let name = tag_name(&name)?;
            let key = name.to_lowercase();
            let scope = entry_scope(&library, |e| {
                e["tags"].as_array().is_some_and(|tags| {
                    tags.iter()
                        .any(|t| t.as_str().is_some_and(|t| t.to_lowercase() == key))
                })
            })?;
            check_entries(&library, &expected_entries, Some(&scope))?;
            let mut changes = Map::new();
            changes.insert("removeTags".into(), json!([name]));
            affected = patch_entries(&mut library, &expected_entries, &changes)?;
            json!({"affectedEntries":affected.len()})
        }
        Command::DeleteFolderEntries {
            folder_id,
            expected_folders,
            expected_entries,
        } => {
            let values = folders(&library)?;
            let scope = descendants(&values, &folder_id)?;
            let current: Vec<Folder> = values
                .into_iter()
                .filter(|f| scope.contains(&f.folder_id))
                .collect();
            require(
                folder_map(&current)? == folder_map(&expected_folders)?,
                "conflict",
                "文件夹树已变化，请重新确认删除范围",
            )?;
            let scope = entry_scope(&library, |e| {
                e["folderId"].as_str().is_some_and(|f| scope.contains(f))
            })?;
            let ids = check_entries(&library, &expected_entries, Some(&scope))?;
            remove_entries(&mut library, &ids);
            json!({"deleted":ids.len()})
        }
    };
    library["revision"] = json!(next_revision);
    result["revision"] = json!(next_revision);
    Ok((
        serde_json::to_vec_pretty(&library)
            .map_err(|_| Error::new("storage", "皮肤库索引编码失败"))?,
        json!({"command":kind,"result":result}),
        affected,
    ))
}

pub(crate) fn validate_import_object(entry: &Value, next: &Tree) -> Result<()> {
    skin_patch::validate_object(entry, next)?;
    let id = entry["skinId"].as_str().unwrap();
    let path = format!(".hanshu/skinmanager/objects/{}/{id}.skin", &id[..2]);
    let (decoded, actual) = codec::decode_disk_file(next[&path].as_ref().unwrap())
        .map_err(|_| invalid("导入皮肤对象编码无效"))?;
    require(
        actual == id
            && entry["textureWidth"].as_u64() == Some(decoded.width.into())
            && entry["textureHeight"].as_u64() == Some(decoded.height.into()),
        "invalid",
        "导入皮肤对象与身份或纹理尺寸不一致",
    )
}

/// Construct a restore against today's library. Entry identity is preserved while
/// revisions advance; unrelated entries and folders survive single-entry restore.
pub(crate) fn restore_history_library(
    before: Option<&[u8]>,
    historical: &[u8],
    entry_id: Option<&str>,
    revision_floor: u64,
) -> Result<Vec<u8>> {
    let empty = json!({"schemaVersion":5,"revision":1,"folders":[],"entries":[]});
    let current = if before.is_some() {
        read_library(before)?
    } else {
        empty.clone()
    };
    let old = read_library(Some(historical))?;
    let mut target = if entry_id.is_some() {
        current.clone()
    } else {
        old.clone()
    };
    if let Some(id) = entry_id {
        identity(id)?;
        let selected = entries(&old)?
            .iter()
            .find(|entry| entry["entryId"] == id)
            .cloned();
        target["entries"]
            .as_array_mut()
            .unwrap()
            .retain(|entry| entry["entryId"] != id);
        if let Some(entry) = selected {
            let old_folders = folders(&old)?;
            let mut parent = entry["folderId"].as_str().map(str::to_owned);
            while let Some(id) = parent {
                if folders(&target)?
                    .iter()
                    .any(|folder| folder.folder_id == id)
                {
                    break;
                }
                let folder = old_folders
                    .iter()
                    .find(|folder| folder.folder_id == id)
                    .ok_or_else(|| invalid("历史条目的文件夹不存在"))?;
                target["folders"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::to_value(folder).unwrap());
                parent = folder.parent_id.clone();
            }
            target["entries"].as_array_mut().unwrap().push(entry);
        }
    }
    validate_folders(&folders(&target)?)?;
    let mut seen = BTreeSet::new();
    let mut changed = before.is_none()
        || target["folders"] != current["folders"]
        || entries(&target)?.len() != entries(&current)?.len();
    let mut restored = Vec::new();
    for entry in entries(&target)? {
        let id = entry["entryId"]
            .as_str()
            .ok_or_else(|| invalid("历史皮肤条目缺少身份"))?;
        require(seen.insert(id.to_owned()), "invalid", "历史皮肤身份重复")?;
        let previous = entries(&current)?
            .iter()
            .find(|entry| entry["entryId"] == id);
        let fields = |entry: &Value| {
            let mut value = entry.clone();
            if let Some(value) = value.as_object_mut() {
                value.remove("revision");
                value.remove("updatedAt");
            }
            value
        };
        if previous.is_some_and(|previous| fields(previous) == fields(entry)) {
            restored.push(previous.unwrap().clone());
            continue;
        }
        changed = true;
        let mut validation = target.clone();
        validation["entries"]
            .as_array_mut()
            .unwrap()
            .retain(|other| other["entryId"] != id);
        let mut validated = import_entry(&validation, entry.clone())?;
        // Never let a restored incarnation accept a stale pre-restore field command.
        let revision = skin_patch::revision(&current["revision"])?
            .max(revision_floor)
            .max(skin_patch::revision(&entry["revision"])?)
            .max(
                previous
                    .and_then(|entry| entry["revision"].as_u64())
                    .unwrap_or(0),
            )
            + 1;
        skin_patch::revision(&json!(revision))?;
        validated["revision"] = json!(revision);
        validated["createdAt"] = json!(skin_patch::text(&entry["createdAt"], 128)?);
        restored.push(validated);
    }
    if !changed {
        return Ok(before.map_or_else(
            || serde_json::to_vec_pretty(&current).unwrap(),
            <[u8]>::to_vec,
        ));
    }
    target["entries"] = json!(restored);
    target["revision"] = json!(
        skin_patch::revision(&current["revision"])?
            .max(skin_patch::revision(&old["revision"])?)
            .max(revision_floor)
            + 1
    );
    skin_patch::revision(&target["revision"])?;
    skin_patch::validate_replacement(before, &target)?;
    serde_json::to_vec_pretty(&target).map_err(|_| Error::new("storage", "历史皮肤恢复编码失败"))
}

/// Garbage collection must not remove the object of a currently retained entry.
pub(crate) fn validate_removed_objects(old: &Tree, next: &Tree) -> Result<()> {
    let removed: BTreeSet<&str> = old
        .keys()
        .filter(|p| p.starts_with(".hanshu/skinmanager/objects/") && !next.contains_key(*p))
        .map(String::as_str)
        .collect();
    if removed.is_empty() {
        return Ok(());
    }
    let Some(Some(bytes)) = next.get(skin_patch::LIBRARY_PATH) else {
        return Ok(());
    };
    let library = read_library(Some(bytes))?;
    for entry in entries(&library)? {
        let id = entry["skinId"].as_str().unwrap_or("");
        require(
            codec::is_valid_skin_id(id),
            "storage",
            "皮肤条目对象身份无效",
        )?;
        let path = format!(".hanshu/skinmanager/objects/{}/{id}.skin", &id[..2]);
        require(
            !removed.contains(path.as_str()),
            "conflict",
            "皮肤对象仍被库中条目引用，不能删除",
        )?;
    }
    Ok(())
}
