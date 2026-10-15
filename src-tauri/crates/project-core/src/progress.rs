use crate::{Error, Result};
use serde_json::Value;
use std::collections::BTreeSet;

/// Mirrors the current .progress structural contract. Unresolved references are valid drafts.
pub fn validate(source: &str) -> Result<()> {
    let invalid = || Error::new("invalid", "进度文档结构无效，服务器未保存");
    if source.len() > 1024 * 1024 {
        return Err(Error::new("invalid", "单份进度文档不能超过 1 MiB"));
    }
    let v: Value = serde_json::from_str(source).map_err(|_| invalid())?;
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
