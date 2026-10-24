use crate::{Error, Result};
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::Value;
use std::collections::BTreeSet;

// Value's default parser accepts duplicate object keys. Author documents must not
// silently discard earlier values, including duplicates inside extension/config data.
struct UniqueJson(Value);
impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "JSON without duplicate keys")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Number(v.into())))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Number(v.into())))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Number(
                    serde_json::Number::from_f64(v).ok_or_else(|| E::custom("invalid number"))?,
                )))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::String(v.into())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::String(v)))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<UniqueJson, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<UniqueJson, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<UniqueJson>()? {
                    values.push(value.0);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<UniqueJson, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = map.next_entry::<String, UniqueJson>()? {
                    if values.insert(key, value.0).is_some() {
                        return Err(de::Error::custom("duplicate object key"));
                    }
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}

pub(crate) fn parse_unique(bytes: &[u8]) -> Result<Value> {
    serde_json::from_slice::<UniqueJson>(bytes)
        .map(|value| value.0)
        .map_err(|_| Error::new("invalid", "JSON 无效或包含重复字段"))
}

/// Mirrors the current .progress structural contract. Unresolved references are valid drafts.
pub fn validate(source: &str) -> Result<()> {
    let invalid = || Error::new("invalid", "进度文档结构无效，服务器未保存");
    if source.len() > 1024 * 1024 {
        return Err(Error::new("invalid", "单份进度文档不能超过 1 MiB"));
    }
    let v = serde_json::from_str::<UniqueJson>(source)
        .map_err(|_| invalid())?
        .0;
    let check = |ok| if ok { Ok(()) } else { Err(invalid()) };
    check(
        v.is_object()
            && v["format"] == "hanshu.progress"
            && v["version"] == 1
            && v.get("groups").is_none(),
    )?;
    let mut ids = BTreeSet::new();
    let id = v["id"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(invalid)?;
    ids.insert(id);
    for k in ["name", "description"] {
        check(v[k].is_string())?;
    }
    if let Some(notes) = v.get("authorNotes") {
        check(notes.is_string())?;
    }
    check(
        matches!(v["completion"].as_str(), Some("all" | "any" | "custom"))
            && v["abandonable"].is_boolean()
            && v.get("autoStartWhenAcceptable")
                .is_none_or(Value::is_boolean),
    )?;
    for goal in v["goals"].as_array().ok_or_else(invalid)? {
        let id = goal["id"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(invalid)?;
        check(ids.insert(id) && goal["kind"].is_string())?;
        for value in goal["config"].as_object().ok_or_else(invalid)?.values() {
            check(
                value.is_string()
                    || value.is_boolean()
                    || value.as_f64().is_some_and(|n| n.is_finite()),
            )?;
        }
    }
    if let Some(graph) = v.get("completionGraph") {
        validate_completion_graph(graph)?;
    } else {
        check(v["completion"] != "custom")?;
    }
    for k in ["visibility", "acceptance"] {
        for rule in v[k].as_array().ok_or_else(invalid)? {
            check(rule["target"].is_string())?;
            check(match rule["kind"].as_str() {
                Some("task") => matches!(
                    rule["state"].as_str(),
                    Some("before_accept" | "after_accept" | "active" | "succeeded" | "ended")
                ),
                Some("dialogue") => matches!(rule["state"].as_str(), Some("before" | "after")),
                Some("expr") => rule["state"].as_str() == Some("true"),
                // Repeat cycle may only be authored under visibility; acceptance gets it as an
                // engine projection ("satisfied"), never as a stored condition slot.
                Some("repeat") => {
                    k == "visibility"
                        && matches!(rule["state"].as_str(), Some("satisfied" | "unsatisfied"))
                        && rule["target"].as_str() == Some("")
                }
                _ => false,
            })?;
        }
    }
    for tag in v["tags"].as_array().ok_or_else(invalid)? {
        check(tag.is_string())?;
    }
    let mut kits = BTreeSet::new();
    for kit in v["rewardKits"].as_array().ok_or_else(invalid)? {
        let s = kit
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(invalid)?;
        check(kits.insert(s))?;
    }
    check(matches!(
        v["repeat"]["kind"].as_str(),
        Some(
            "once"
                | "game_daily"
                | "game_weekly"
                | "real_daily"
                | "real_weekly"
                | "real_monthly"
                | "duration"
                | "manual"
        )
    ))?;
    if v["repeat"]["kind"] == "duration" {
        check(
            v["repeat"]["hours"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n > 0.),
        )?;
    }
    Ok(())
}

/// Drafts may be incomplete or reference a deleted goal. Topology must still be a forest.
fn validate_completion_graph(graph: &Value) -> Result<()> {
    use std::collections::BTreeMap;
    let invalid = || Error::new("invalid", "自定义完成图结构无效，服务器未保存");
    let check = |ok| if ok { Ok(()) } else { Err(invalid()) };
    let keys = |v: &Value, allowed: &[&str]| {
        v.as_object()
            .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
    };
    check(keys(graph, &["nodes", "links"]))?;
    let nodes = graph["nodes"].as_array().ok_or_else(invalid)?;
    let links = graph["links"].as_array().ok_or_else(invalid)?;
    check(nodes.len() <= 512 && links.len() <= 1024)?;
    let mut ids = BTreeSet::new();
    let mut by_id = BTreeMap::new();
    let mut outputs = 0;
    for node in nodes {
        let id = node["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(invalid)?;
        check(ids.insert(id))?;
        match node["type"].as_str() {
            Some("goal") => {
                check(keys(node, &["id", "type", "goalId"]) && node["goalId"].is_string())?
            }
            Some("logic") => check(
                keys(node, &["id", "type", "op"])
                    && matches!(node["op"].as_str(), Some("and" | "or" | "not" | "xor")),
            )?,
            Some("output") => {
                check(keys(node, &["id", "type"]))?;
                outputs += 1;
            }
            _ => return Err(invalid()),
        }
        by_id.insert(id, node);
    }
    check(outputs == 1)?;
    let mut outgoing = BTreeMap::new();
    let mut incoming = BTreeMap::new();
    for link in links {
        check(keys(link, &["id", "from", "to"]))?;
        let id = link["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(invalid)?;
        check(ids.insert(id))?;
        let from = link["from"].as_str().ok_or_else(invalid)?;
        let to = link["to"].as_str().ok_or_else(invalid)?;
        let source = by_id.get(from).ok_or_else(invalid)?;
        let target = by_id.get(to).ok_or_else(invalid)?;
        check(source["type"] != "output" && outgoing.insert(from, to).is_none())?;
        let limit = if target["type"] == "goal" {
            0
        } else if target["type"] == "output" || target["op"] == "not" {
            1
        } else if target["op"] == "xor" {
            2
        } else {
            usize::MAX
        };
        let count = incoming.entry(to).or_insert(0usize);
        *count += 1;
        check(*count <= limit)?;
    }
    for id in by_id.keys() {
        let mut seen = BTreeSet::new();
        let mut current = Some(*id);
        while let Some(id) = current {
            check(seen.insert(id))?;
            current = outgoing.get(id).copied();
        }
    }
    Ok(())
}

/// An immutable receipt is a historical snapshot, not a document being authored today.
/// Validate stable format/identity/JSON invariants, not evolving completion/condition rules.
/// Its source bytes must remain unchanged for exact replay and selective undo.
pub(crate) fn validate_receipt_snapshot(source: &str, document_id: &str) -> Result<()> {
    let invalid = || Error::new("storage", "持久进度回执内容或文档身份无效");
    if source.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let v = parse_unique(source.as_bytes()).map_err(|_| invalid())?;
    let check = |ok| if ok { Ok(()) } else { Err(invalid()) };
    check(
        v.is_object()
            && v["format"] == "hanshu.progress"
            && v["version"] == 1
            && v["id"].as_str() == Some(document_id)
            && !document_id.trim().is_empty()
            && v["name"].is_string()
            && v["description"].is_string(),
    )?;
    let mut ids = BTreeSet::from([document_id]);
    for goal in v["goals"].as_array().ok_or_else(invalid)? {
        let id = goal["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(invalid)?;
        check(ids.insert(id) && goal["kind"].is_string())?;
        for value in goal["config"].as_object().ok_or_else(invalid)?.values() {
            check(
                value.is_string()
                    || value.is_boolean()
                    || value.as_f64().is_some_and(|n| n.is_finite()),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod receipt_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn historical_snapshot_rules_are_stable_but_identity_and_json_remain_strict() {
        let snapshot = json!({"format":"hanshu.progress","version":1,"id":"doc","name":"name","description":"description",
            "goals":[{"id":"g","kind":"old-goal-type","config":{"count":1}}],"completion":"old-rule"});
        let source = snapshot.to_string();
        assert!(validate_receipt_snapshot(&source, "doc").is_ok());
        assert!(
            validate(&source).is_err(),
            "historical validation must not replace authoring validation"
        );
        assert!(validate_receipt_snapshot(&source, "wrong-doc").is_err());
        let mut damaged = snapshot.clone();
        damaged["goals"][0]["config"] = json!([]);
        assert!(validate_receipt_snapshot(&damaged.to_string(), "doc").is_err());
        let mut duplicate_goal = snapshot.clone();
        duplicate_goal["goals"] = json!([snapshot["goals"][0], snapshot["goals"][0]]);
        assert!(validate_receipt_snapshot(&duplicate_goal.to_string(), "doc").is_err());
        assert!(
            validate_receipt_snapshot(&source.replacen("{", "{\"id\":\"other\",", 1), "doc")
                .is_err()
        );
        assert!(validate_receipt_snapshot("{broken", "doc").is_err());
    }
}
