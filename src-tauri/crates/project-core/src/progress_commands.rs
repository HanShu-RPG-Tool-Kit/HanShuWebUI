//! Field-scoped progress edits and selective undo share the durable file transaction.
//! Clients describe their read set; the service derives fresh source/language writes.
use super::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressSlot {
    pub present: bool,
    #[ts(type = "unknown")]
    pub value: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProgressTarget {
    Field {
        #[ts(
            type = "'name' | 'description' | 'authorNotes' | 'tags' | 'completion' | 'completionGraph' | 'visibility' | 'acceptance' | 'abandonable' | 'autoStartWhenAcceptable' | 'repeat' | 'rewardKits'"
        )]
        field: String,
    },
    GoalConfig {
        goal_id: String,
        goal_kind: String,
        key: String,
    },
    GoalBody {
        goal_id: String,
    },
    Goal {
        goal_id: String,
    },
    GoalOrder {},
    Locale {
        locale: String,
        key: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressEffect {
    pub target: ProgressTarget,
    pub expected: ProgressSlot,
    pub value: ProgressSlot,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(
    tag = "command",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProgressCommand {
    Apply {
        document_id: String,
        changes: Vec<ProgressEffect>,
    },
    Revert {
        transaction_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressLanguage {
    pub path: String,
    pub content: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgressCommandResult {
    pub path: String,
    pub document_id: String,
    pub effects: Vec<ProgressEffect>,
    pub source: String,
    pub languages: Vec<ProgressLanguage>,
}

fn slot(value: Option<&Value>) -> ProgressSlot {
    ProgressSlot {
        present: value.is_some(),
        value: value.cloned().unwrap_or(Value::Null),
    }
}
fn normalized(mut value: ProgressSlot) -> ProgressSlot {
    if !value.present {
        value.value = Value::Null;
    }
    value
}
fn canonical_slot(target: &ProgressTarget, value: ProgressSlot) -> ProgressSlot {
    let mut value = normalized(value);
    if matches!(target, ProgressTarget::Field { field } if field == "repeat")
        && value.present
        && value.value["kind"] != "duration"
    {
        if let Some(fields) = value.value.as_object_mut() {
            fields.remove("hours");
        }
    }
    value
}
fn conflict() -> Error {
    Error::new(
        "conflict",
        "这个进度字段已被其他编辑者修改，请保留草稿并查看最新值",
    )
}
fn identity(value: &str) -> Result<()> {
    require(
        !value.is_empty() && value.len() <= 1024 && !value.chars().any(char::is_control),
        "invalid",
        "进度字段身份无效",
    )
}
fn field_ok(field: &str) -> Result<()> {
    require(
        matches!(
            field,
            "name"
                | "description"
                | "authorNotes"
                | "tags"
                | "completion"
                | "completionGraph"
                | "visibility"
                | "acceptance"
                | "abandonable"
                | "autoStartWhenAcceptable"
                | "repeat"
                | "rewardKits"
        ),
        "invalid",
        "不能通过进度字段操作替换文档身份或结构",
    )
}
fn goal<'a>(document: &'a Value, id: &str) -> Option<&'a Value> {
    document["goals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|goal| goal["id"] == id)
}
fn goal_mut<'a>(document: &'a mut Value, id: &str) -> Result<&'a mut Value> {
    document["goals"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|goal| goal["id"] == id)
        .ok_or_else(conflict)
}
fn language_path(source: &str, locale: &str) -> Result<String> {
    require(
        !locale.is_empty()
            && locale.len() <= 64
            && locale
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
        "invalid",
        "语言名称无效",
    )?;
    let source = crate::resource_relations::source(source)
        .filter(|source| source.kind == "quest")
        .ok_or_else(|| Error::new("invalid", "进度操作只能作用于任务源文件"))?;
    let path = format!("assets/{locale}/lang_quest/{}.lang", source.stem);
    path_ok(&path)?;
    Ok(path)
}
fn read_language(tree: &Tree, path: &str) -> Result<Value> {
    match tree.get(path) {
        None => Ok(json!({})),
        Some(None) => Err(Error::new("conflict", "语言文件路径已被目录占用")),
        Some(Some(bytes)) => {
            require(
                bytes.len() <= 1024 * 1024,
                "invalid",
                "进度语言文件超过 1 MiB",
            )?;
            let value = crate::progress::parse_unique(bytes)?;
            require(
                value
                    .as_object()
                    .is_some_and(|map| map.values().all(Value::is_string)),
                "invalid",
                "进度语言文件必须是文本映射，原始内容未被替换",
            )?;
            Ok(value)
        }
    }
}
fn encode(value: &Value) -> Result<String> {
    serde_json::to_string_pretty(value)
        .map(|value| format!("{value}\n"))
        .map_err(|_| Error::new("invalid", "进度内容编码失败"))
}
fn read_target(
    document: &Value,
    languages: &BTreeMap<String, Value>,
    target: &ProgressTarget,
) -> Result<ProgressSlot> {
    Ok(match target {
        ProgressTarget::Field { field } => {
            field_ok(field)?;
            if field == "authorNotes" && document.get(field).is_none() {
                slot(Some(&json!("")))
            } else {
                slot(document.get(field))
            }
        }
        ProgressTarget::GoalConfig {
            goal_id,
            goal_kind,
            key,
        } => {
            identity(goal_id)?;
            identity(key)?;
            let goal = goal(document, goal_id).ok_or_else(conflict)?;
            require(
                goal["kind"] == *goal_kind,
                "conflict",
                "目标类型已改变，请重新检查参数",
            )?;
            slot(goal["config"].get(key))
        }
        ProgressTarget::GoalBody { goal_id } => {
            identity(goal_id)?;
            let goal = goal(document, goal_id).ok_or_else(conflict)?;
            slot(Some(&json!({"kind":goal["kind"],"config":goal["config"]})))
        }
        ProgressTarget::Goal { goal_id } => {
            identity(goal_id)?;
            slot(goal(document, goal_id))
        }
        ProgressTarget::GoalOrder {} => slot(Some(&Value::Array(
            document["goals"]
                .as_array()
                .unwrap()
                .iter()
                .map(|goal| goal["id"].clone())
                .collect(),
        ))),
        ProgressTarget::Locale { locale, key } => {
            identity(key)?;
            slot(languages[locale].get(key))
        }
    })
}
fn target_key(target: &ProgressTarget) -> String {
    // Structured serialization keeps identities containing separators distinct.
    serde_json::to_string(target).unwrap()
}
fn goals_overlap(a: &ProgressTarget, b: &ProgressTarget) -> bool {
    let identity = |target: &ProgressTarget| match target {
        ProgressTarget::Goal { goal_id } | ProgressTarget::GoalBody { goal_id } => {
            Some((goal_id.clone(), None))
        }
        ProgressTarget::GoalConfig { goal_id, key, .. } => {
            Some((goal_id.clone(), Some(key.clone())))
        }
        _ => None,
    };
    match (identity(a), identity(b)) {
        (Some((a, ak)), Some((b, bk))) if a == b => ak.is_none() || bk.is_none() || ak == bk,
        _ => false,
    }
}

impl Engine {
    pub(super) fn expand_progress_command(
        &mut self,
        sid: &str,
        input: &[FileChange],
        now: u64,
    ) -> Result<(Vec<FileChange>, Vec<Lease>, ProgressCommandResult)> {
        self.writer(sid)?;
        require(
            input.len() == 1
                && input[0].op == "progress-command"
                && input[0].destination.is_none()
                && input[0].destination_version.is_none(),
            "invalid",
            "进度业务操作不能与其他文件操作混合",
        )?;
        let input = &input[0];
        path_ok(&input.path)?;
        require(
            crate::resource_relations::source(&input.path)
                .is_some_and(|source| source.kind == "progress"),
            "invalid",
            "进度操作只能作用于进度源文件",
        )?;
        let bytes = STANDARD
            .decode(
                input
                    .content
                    .as_deref()
                    .ok_or_else(|| Error::new("invalid", "进度操作缺少内容"))?,
            )
            .map_err(|_| Error::new("invalid", "进度操作编码无效"))?;
        require(bytes.len() <= 2 * 1024 * 1024, "invalid", "进度操作过大")?;
        let command: ProgressCommand =
            serde_json::from_value(crate::progress::parse_unique(&bytes)?)
                .map_err(|_| Error::new("invalid", "进度操作格式无效"))?;
        let (document_id, changes) = match command {
            ProgressCommand::Apply {
                document_id,
                changes,
            } => (document_id, changes),
            ProgressCommand::Revert { transaction_id } => {
                let receipt = self.file_transaction(sid, &transaction_id)?;
                require(
                    receipt.status == FileTransactionStatus::Committed,
                    "invalid",
                    "只能撤销已提交的进度操作",
                )?;
                let result = receipt
                    .progress_result
                    .ok_or_else(|| Error::new("invalid", "此事务不是可撤销的进度操作"))?;
                require(
                    result.path == input.path && !result.effects.is_empty(),
                    "invalid",
                    "只能撤销同一文档内产生有效修改的进度操作",
                )?;
                (
                    result.document_id,
                    result
                        .effects
                        .into_iter()
                        .map(|effect| ProgressEffect {
                            target: effect.target,
                            expected: effect.value,
                            value: effect.expected,
                        })
                        .collect(),
                )
            }
        };
        identity(&document_id)?;
        require(
            !changes.is_empty() && changes.len() <= 256,
            "invalid",
            "进度操作须包含 1 至 256 个字段修改",
        )?;
        let store = self
            .files
            .as_ref()
            .ok_or_else(|| Error::new("invalid", "未打开目录工程"))?;
        let tree = store.scan()?;
        let before = tree
            .get(&input.path)
            .and_then(Option::as_ref)
            .ok_or_else(|| Error::new("conflict", "进度源文件已不存在，请先完成初次保存"))?;
        let source =
            std::str::from_utf8(before).map_err(|_| Error::new("invalid", "进度须为 UTF-8"))?;
        crate::progress::validate(source)?;
        let document: Value = serde_json::from_slice(before).unwrap();
        require(
            document["id"] == document_id,
            "conflict",
            "进度文档身份已改变，请重新打开文档",
        )?;
        let mut languages = BTreeMap::new();
        let mut language_paths = BTreeMap::new();
        for change in &changes {
            if let ProgressTarget::Locale { locale, .. } = &change.target {
                let path = language_path(&input.path, locale)?;
                if !languages.contains_key(locale) {
                    languages.insert(locale.clone(), read_language(&tree, &path)?);
                    language_paths.insert(locale.clone(), path);
                }
            }
        }
        let mut seen = BTreeSet::new();
        let mut effects: Vec<ProgressEffect> = Vec::new();
        for (index, change) in changes.iter().enumerate() {
            require(
                seen.insert(target_key(&change.target))
                    && !changes[..index]
                        .iter()
                        .any(|other| goals_overlap(&other.target, &change.target)),
                "invalid",
                "同一操作不能重复或交叠修改同一字段",
            )?;
            let actual = canonical_slot(
                &change.target,
                read_target(&document, &languages, &change.target)?,
            );
            require(
                actual == canonical_slot(&change.target, change.expected.clone()),
                "conflict",
                &conflict().message,
            )?;
            let value = canonical_slot(&change.target, change.value.clone());
            if actual != value {
                effects.push(ProgressEffect {
                    target: change.target.clone(),
                    expected: actual,
                    value,
                });
            }
        }
        let mut next = document.clone();
        for effect in &effects {
            match &effect.target {
                ProgressTarget::Field { field } => {
                    if effect.value.present {
                        next[field] = effect.value.value.clone();
                    } else {
                        require(
                            field == "completionGraph",
                            "invalid",
                            "进度文档字段不能删除",
                        )?;
                        next.as_object_mut().unwrap().remove(field);
                    }
                }
                ProgressTarget::GoalConfig { goal_id, key, .. } => {
                    let config = goal_mut(&mut next, goal_id)?["config"]
                        .as_object_mut()
                        .unwrap();
                    if effect.value.present {
                        config.insert(key.clone(), effect.value.value.clone());
                    } else {
                        config.remove(key);
                    }
                }
                ProgressTarget::GoalBody { goal_id } => {
                    let value = &effect.value.value;
                    require(
                        effect.value.present
                            && value.as_object().is_some_and(|map| {
                                map.len() == 2
                                    && map.contains_key("kind")
                                    && map.contains_key("config")
                            }),
                        "invalid",
                        "目标类型修改须包含 kind 和 config",
                    )?;
                    let goal = goal_mut(&mut next, goal_id)?;
                    goal["kind"] = value["kind"].clone();
                    goal["config"] = value["config"].clone();
                }
                ProgressTarget::Goal { goal_id } => {
                    require(
                        effect.expected.present != effect.value.present,
                        "invalid",
                        "目标增删操作不能替换已有目标",
                    )?;
                    require(
                        changes
                            .iter()
                            .any(|change| matches!(change.target, ProgressTarget::GoalOrder {})),
                        "invalid",
                        "增删目标必须同时提交顺序条件",
                    )?;
                    let goals = next["goals"].as_array_mut().unwrap();
                    if effect.value.present {
                        require(
                            effect.value.value["id"] == *goal_id,
                            "invalid",
                            "目标身份不一致",
                        )?;
                        goals.push(effect.value.value.clone());
                    } else {
                        goals.retain(|goal| goal["id"] != *goal_id);
                    }
                }
                ProgressTarget::GoalOrder {} => {}
                ProgressTarget::Locale { locale, key } => {
                    let values = languages.get_mut(locale).unwrap().as_object_mut().unwrap();
                    if effect.value.present {
                        require(
                            effect.value.value.is_string(),
                            "invalid",
                            "进度译文必须是文本",
                        )?;
                        values.insert(key.clone(), effect.value.value.clone());
                    } else {
                        values.remove(key);
                    }
                }
            }
        }
        for effect in changes
            .iter()
            .filter(|effect| matches!(effect.target, ProgressTarget::GoalOrder {}))
        {
            let ids = effect
                .value
                .value
                .as_array()
                .filter(|_| effect.value.present)
                .ok_or_else(|| Error::new("invalid", "目标顺序必须是目标身份列表"))?;
            let goals = next["goals"].as_array().unwrap();
            require(
                ids.len() == goals.len()
                    && ids.iter().all(Value::is_string)
                    && ids
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<BTreeSet<_>>()
                        .len()
                        == ids.len(),
                "invalid",
                "目标顺序缺少、重复或含有无效身份",
            )?;
            let ordered = ids
                .iter()
                .map(|id| {
                    goals
                        .iter()
                        .find(|goal| goal["id"] == *id)
                        .cloned()
                        .ok_or_else(|| Error::new("invalid", "目标顺序与目标列表不一致"))
                })
                .collect::<Result<Vec<_>>>()?;
            next["goals"] = Value::Array(ordered);
        }
        let next_source = if next == document {
            source.to_owned()
        } else {
            encode(&next)?
        };
        crate::progress::validate(&next_source)?;
        let mut writes = Vec::new();
        let write = |path: String, content: String| FileChange {
            op: "write".into(),
            version: version(&tree, &path),
            path,
            content: Some(STANDARD.encode(content)),
            destination: None,
            destination_version: None,
            lease_id: String::new(),
        };
        if next_source != source {
            writes.push(write(input.path.clone(), next_source.clone()));
        }
        let mut acknowledged = Vec::new();
        for (locale, values) in languages {
            let path = language_paths[&locale].clone();
            let old = tree.get(&path).and_then(Option::as_ref);
            let changed = effects.iter().any(|effect| matches!(&effect.target, ProgressTarget::Locale { locale: target, .. } if target == &locale));
            let content = if changed {
                Some(encode(&values)?)
            } else {
                old.map(|bytes| String::from_utf8(bytes.clone()).unwrap())
            };
            if let Some(content) = &content {
                require(
                    content.len() <= 1024 * 1024,
                    "invalid",
                    "进度语言文件超过 1 MiB",
                )?;
                if old.map(Vec::as_slice) != Some(content.as_bytes()) {
                    writes.push(write(path.clone(), content.clone()));
                }
            }
            acknowledged.push(ProgressLanguage { path, content });
        }
        // The source identity participates even in a locale-only edit/no-op.
        if !writes.iter().any(|change| change.path == input.path) {
            writes.push(FileChange {
                op: "check".into(),
                path: input.path.clone(),
                version: version(&tree, &input.path),
                content: None,
                destination: None,
                destination_version: None,
                lease_id: String::new(),
            });
        }
        let requests = writes
            .iter()
            .map(|change| {
                Ok(crate::FileOperationRequest {
                    op: crate::FileOperationKind::parse(&change.op)?,
                    path: change.path.clone(),
                    destination: None,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let plan = crate::resource_policy::plan(&tree, store.revision, &requests)?;
        let existing = self
            .leases
            .values()
            .map(|lease| lease.id.clone())
            .collect::<BTreeSet<_>>();
        let acquired = self.acquire_files(sid, &plan.lease_paths, false, now)?;
        for change in &mut writes {
            change.lease_id = acquired
                .iter()
                .find(|lease| lease.resource_id == format!("file:{}", change.path))
                .ok_or_else(|| Error::new("locked", "进度操作缺少写权"))?
                .id
                .clone();
        }
        Ok((
            writes,
            acquired
                .into_iter()
                .filter(|lease| !existing.contains(&lease.id))
                .collect(),
            ProgressCommandResult {
                path: input.path.clone(),
                document_id,
                effects,
                source: next_source,
                languages: acknowledged,
            },
        ))
    }
}
