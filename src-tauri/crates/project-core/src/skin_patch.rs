//! Semantic skin edits operate on the authoritative tree inside the existing file transaction.
//! They never open a separate Storage instance or publish files outside its durable journal.
use crate::{files::Tree, require, Error, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use skin_core::{
    codec::SkinModel,
    storage::{normalize_custom_id, normalize_name, normalize_tag_list, now_iso_public},
};

pub(crate) const LIBRARY_PATH: &str = ".hanshu/skinmanager/library.json";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Whole-index operations retain file CAS, but they must also preserve the entry
/// revisions on which semantic commands rely. Reject invalid input; never rewrite
/// the candidate, because its exact content hash is the client's acknowledgement.
pub(crate) fn validate_replacement(before: Option<&[u8]>, next: &Value) -> Result<()> {
    let Some(previous) = before.and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
    else {
        return Ok(());
    };
    if previous["schemaVersion"] != 5 || next["schemaVersion"] != 5 {
        return Ok(());
    }
    fn entries(
        value: &Value,
        code: &'static str,
    ) -> Result<std::collections::BTreeMap<String, Value>> {
        let values = value["entries"]
            .as_array()
            .ok_or_else(|| Error::new(code, "皮肤库条目列表无效"))?;
        let mut out = std::collections::BTreeMap::new();
        for entry in values {
            let fields = entry
                .as_object()
                .ok_or_else(|| Error::new(code, "皮肤条目必须为对象"))?;
            let id = fields
                .get("entryId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| Error::new(code, "皮肤条目身份无效"))?;
            require(
                fields
                    .get("revision")
                    .and_then(Value::as_u64)
                    .is_some_and(|revision| revision > 0 && revision <= MAX_SAFE_INTEGER),
                code,
                "皮肤条目修订号无效",
            )?;
            require(
                out.insert(id.to_owned(), entry.clone()).is_none(),
                code,
                "皮肤库包含重复的条目身份",
            )?;
        }
        Ok(out)
    }
    let previous_entries = entries(&previous, "storage")?;
    let next_entries = entries(next, "invalid")?;
    for (id, next_entry) in &next_entries {
        let Some(previous_entry) = previous_entries.get(id) else {
            continue;
        };
        // Validation above proves these are objects with nonzero integer revisions.
        let old_revision = previous_entry["revision"].as_u64().unwrap();
        let next_revision = next_entry["revision"].as_u64().unwrap();
        let mut old_fields = previous_entry.as_object().unwrap().clone();
        let mut next_fields = next_entry.as_object().unwrap().clone();
        old_fields.remove("revision");
        next_fields.remove("revision");
        require(
            next_revision >= old_revision
                && (old_fields == next_fields || next_revision > old_revision),
            "invalid",
            "皮肤条目内容变化时必须提高修订号，不能用旧索引回退条目版本；请刷新皮肤库后重新操作",
        )?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryPatch {
    entry_id: String,
    expected_revision: u64,
    changes: Map<String, Value>,
}

pub(crate) fn text(value: &Value, max: usize) -> Result<&str> {
    let value = value
        .as_str()
        .ok_or_else(|| Error::new("invalid", "皮肤字段必须为文本"))?;
    require(value.chars().count() <= max, "invalid", "皮肤字段内容过长")?;
    Ok(value)
}

pub(crate) fn tags(value: &Value) -> Result<Vec<String>> {
    let values = value
        .as_array()
        .ok_or_else(|| Error::new("invalid", "皮肤标签必须为文本列表"))?;
    require(values.len() <= 256, "invalid", "皮肤标签数量过多")?;
    let raw = values
        .iter()
        .map(|v| text(v, 512).map(str::to_owned))
        .collect::<Result<Vec<_>>>()?;
    Ok(normalize_tag_list(raw))
}

/// License and provenance are complete value objects: omission clears optional fields.
pub(crate) fn metadata(value: &Value, license: bool) -> Result<Value> {
    let fields = if license {
        &["status", "name", "url", "note"][..]
    } else {
        &[
            "author",
            "sourceName",
            "sourceUrl",
            "sourceNote",
            "originalCreatedAt",
        ][..]
    };
    let values = value
        .as_object()
        .ok_or_else(|| Error::new("invalid", "皮肤来源或协议必须为对象"))?;
    require(
        values.keys().all(|key| fields.contains(&key.as_str())),
        "invalid",
        "皮肤来源或协议包含未知字段",
    )?;
    let mut out = Map::new();
    for field in fields {
        let value = values.get(*field).cloned().unwrap_or(Value::Null);
        if *field == "status" {
            require(
                matches!(value.as_str(), Some("unspecified" | "declared")),
                "invalid",
                "皮肤协议状态无效",
            )?;
        } else if !value.is_null() {
            text(&value, 8192)?;
        }
        out.insert((*field).into(), value);
    }
    Ok(Value::Object(out))
}

pub(crate) fn revision(value: &Value) -> Result<u64> {
    value
        .as_u64()
        .filter(|v| *v > 0 && *v < MAX_SAFE_INTEGER)
        .ok_or_else(|| Error::new("storage", "皮肤库修订号无效或已达到上限"))
}

pub(crate) fn apply(before: &[u8], command: &[u8]) -> Result<(Vec<u8>, Value)> {
    require(
        command.len() <= 64 * 1024,
        "invalid",
        "皮肤条目修改超过 64 KiB",
    )?;
    let patch: EntryPatch = serde_json::from_slice(command)
        .map_err(|_| Error::new("invalid", "皮肤条目修改结构无效"))?;
    let mut library: Value =
        serde_json::from_slice(before).map_err(|_| Error::new("storage", "皮肤库索引损坏"))?;
    let library_revision = revision(&library["revision"])?;
    let entry = patch_entry(
        &mut library,
        &patch.entry_id,
        patch.expected_revision,
        &patch.changes,
    )?;
    library["revision"] = json!(library_revision + 1);
    let encoded = serde_json::to_vec_pretty(&library)
        .map_err(|_| Error::new("storage", "皮肤库索引编码失败"))?;
    Ok((encoded, entry))
}

/// Mutate a checked in-memory index. A batch serializes and advances its library
/// revision once; serializing the entire library per target would be quadratic.
pub(crate) fn patch_entry(
    library: &mut Value,
    entry_id: &str,
    expected_revision: u64,
    changes: &Map<String, Value>,
) -> Result<Value> {
    require(
        !entry_id.is_empty()
            && entry_id.len() <= 256
            && expected_revision > 0
            && expected_revision < MAX_SAFE_INTEGER,
        "invalid",
        "皮肤条目身份或预期修订号无效",
    )?;
    const ALLOWED: &[&str] = &[
        "name",
        "tags",
        "addTags",
        "removeTags",
        "favorite",
        "folderId",
        "active",
        "model",
        "license",
        "provenance",
        "note",
        "customId",
    ];
    require(
        !changes.is_empty() && changes.keys().all(|key| ALLOWED.contains(&key.as_str())),
        "invalid",
        "皮肤条目修改为空或包含未知字段",
    )?;
    require(
        library["schemaVersion"] == 5
            && library["entries"].is_array()
            && library["folders"].is_array(),
        "storage",
        "皮肤库索引结构无效",
    )?;
    let entries = library["entries"].as_array().unwrap();
    let targets = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e["entryId"] == entry_id)
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    require(
        !targets.is_empty(),
        "conflict",
        "皮肤条目已被删除，草稿仍保留",
    )?;
    require(targets.len() == 1, "storage", "皮肤库包含重复的条目身份")?;
    let index = targets[0];
    let mut entry = entries[index].clone();
    let current_revision = revision(&entry["revision"])?;
    require(
        current_revision == expected_revision,
        "conflict",
        "此皮肤已被其他客户端修改，草稿仍保留",
    )?;

    for (field, value) in changes {
        match field.as_str() {
            "name" => {
                let name = normalize_name(text(value, 256)?);
                require(!name.is_empty(), "invalid", "皮肤名称不能为空")?;
                entry[field] = json!(name);
            }
            "note" => {
                text(value, 16_384)?;
                entry[field] = value.clone();
            }
            "favorite" | "active" => {
                require(value.is_boolean(), "invalid", "皮肤开关字段必须为布尔值")?;
                entry[field] = value.clone();
            }
            "model" => {
                require(
                    value.as_str().and_then(SkinModel::parse).is_some(),
                    "invalid",
                    "皮肤模型必须为 classic 或 slim",
                )?;
                entry[field] = value.clone();
            }
            "folderId" => {
                if !value.is_null() {
                    let id = text(value, 256)?;
                    require(
                        library["folders"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|folder| folder["folderId"] == id),
                        "conflict",
                        "目标皮肤文件夹已不存在",
                    )?;
                }
                entry[field] = value.clone();
            }
            "customId" => {
                let raw = if value.is_null() {
                    None
                } else {
                    Some(text(value, 1024)?)
                };
                let id = normalize_custom_id(raw)
                    .map_err(|_| Error::new("invalid", "自定义 ID 最长 64 字符"))?;
                if let Some(id) = &id {
                    require(
                        !entries
                            .iter()
                            .enumerate()
                            .any(|(i, e)| i != index && e["customId"] == *id),
                        "conflict",
                        "自定义 ID 已被其他皮肤使用",
                    )?;
                }
                entry[field] = json!(id);
            }
            "license" => entry[field] = metadata(value, true)?,
            "provenance" => entry[field] = metadata(value, false)?,
            "tags" | "addTags" | "removeTags" => {
                tags(value)?;
            }
            _ => unreachable!(),
        }
    }
    let mut next_tags = if let Some(value) = changes.get("tags") {
        tags(value)?
    } else {
        tags(&entry["tags"])?
    };
    if let Some(value) = changes.get("addTags") {
        next_tags.extend(tags(value)?);
        next_tags = normalize_tag_list(next_tags);
    }
    if let Some(value) = changes.get("removeTags") {
        let removed = tags(value)?
            .into_iter()
            .map(|tag| tag.to_lowercase())
            .collect::<Vec<_>>();
        next_tags.retain(|tag| !removed.contains(&tag.to_lowercase()));
    }
    require(next_tags.len() <= 256, "invalid", "皮肤标签数量过多")?;
    entry["tags"] = json!(next_tags);
    entry["revision"] = json!(current_revision + 1);
    entry["updatedAt"] = json!(now_iso_public());
    library["entries"][index] = entry.clone();
    Ok(entry)
}

pub(crate) fn validate_object(entry: &Value, next: &Tree) -> Result<()> {
    let id = entry["skinId"].as_str().unwrap_or("");
    require(
        id.len() == 64
            && id
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "storage",
        "皮肤条目对象身份无效",
    )?;
    let path = format!(".hanshu/skinmanager/objects/{}/{id}.skin", &id[..2]);
    require(
        matches!(next.get(&path), Some(Some(_))),
        "conflict",
        "皮肤对象已不存在",
    )
}
