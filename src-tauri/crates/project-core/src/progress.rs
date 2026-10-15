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
        matches!(v["completion"].as_str(), Some("all" | "any")) && v["abandonable"].is_boolean(),
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
    for k in ["visibility", "acceptance"] {
        for rule in v[k].as_array().ok_or_else(invalid)? {
            check(rule["target"].is_string())?;
            check(match rule["kind"].as_str() {
                Some("task") => matches!(
                    rule["state"].as_str(),
                    Some("before_accept" | "after_accept" | "active" | "succeeded" | "ended")
                ),
                Some("dialogue") => matches!(rule["state"].as_str(), Some("before" | "after")),
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
