//! Resource facts only. Ownership and references do not grant locks or cascade operations.
use crate::files::{nested, path_ok, Tree};
use serde::Serialize;
use std::collections::BTreeSet;
use ts_rs::TS;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ResourceRelationKind {
    Ownership,
    Reference,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ResourceRelationRole {
    Language,
    Voice,
    RewardKit,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRelation {
    pub kind: ResourceRelationKind,
    pub role: ResourceRelationRole,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRelations {
    pub path: String,
    pub relations: Vec<ResourceRelation>,
}

#[derive(Clone, Debug)]
pub(crate) struct Source {
    pub path: String,
    pub kind: String,
    pub stem: String,
}

fn source_directory(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "hs" => "hanshu",
        "char" => "character",
        "progress" => "progress",
        "hflow" => "story",
        "nav" => "navigator",
        "kit" => "gift",
        "item" => "items",
        "entity" => "entities",
        _ => return None,
    })
}

pub(crate) fn source(path: &str) -> Option<Source> {
    let rest = path.strip_prefix("src/")?;
    let (directory, logical) = rest.split_once('/')?;
    let (stem, extension) = logical.rsplit_once('.')?;
    let kind = extension.to_ascii_lowercase();
    if source_directory(&kind)? != directory || stem.is_empty() {
        return None;
    }
    Some(Source {
        path: path.into(),
        kind,
        stem: stem.into(),
    })
}

fn asset(path: &str) -> Option<(&str, &str, &str)> {
    let (locale, tail) = path.strip_prefix("assets/")?.split_once('/')?;
    let (category, logical) = tail.split_once('/')?;
    Some((locale, category, logical))
}

/// Resolve audio against the longest *actual source* prefix. A clip may have arbitrary
/// subdirectories beneath its source's voice directory; its immediate parent is not a source.
pub(crate) fn asset_owner(
    path: &str,
    tree: &Tree,
) -> Option<(Source, ResourceRelationRole, String)> {
    let (locale, category, logical) = asset(path)?;
    if let Some(kind) = category.strip_prefix("lang_") {
        if !logical.to_ascii_lowercase().ends_with(".lang") {
            return None;
        }
        let stem = &logical[..logical.len() - 5];
        let owner = tree
            .iter()
            .filter(|(_, bytes)| bytes.is_some())
            .filter_map(|(path, _)| source(path))
            .find(|candidate| candidate.kind == kind && candidate.stem == stem)
            .or_else(|| source(&format!("src/{}/{stem}.{kind}", source_directory(kind)?)))?;
        return Some((owner, ResourceRelationRole::Language, path.into()));
    }
    let kind = category.strip_prefix("voice_")?;
    let directory = source_directory(kind)?;
    let owner = tree
        .iter()
        .filter(|(_, bytes)| bytes.is_some())
        .filter_map(|(path, _)| source(path))
        .filter(|candidate| candidate.kind == kind && nested(&candidate.stem, logical))
        .max_by_key(|candidate| candidate.stem.len())
        .or_else(|| {
            // Before the first source save, a direct voice clip still has its conventional
            // owner. A batch with a new source supplies that source to the resolver explicitly.
            let stem = if matches!(tree.get(path), Some(None)) {
                logical
            } else {
                logical.rsplit_once('/')?.0
            };
            source(&format!("src/{directory}/{stem}.{kind}"))
        })?;
    let root = format!("assets/{locale}/voice_{kind}/{}", owner.stem);
    Some((owner, ResourceRelationRole::Voice, root))
}

pub(crate) fn resolve(tree: &Tree) -> Vec<ResourceRelation> {
    let mut relations = BTreeSet::new();
    for (path, bytes) in tree {
        if let Some((owner, role, target)) = asset_owner(path, tree) {
            // Intermediate voice directories without an actual source are not independent
            // resources. File entries and known source roots supply the ownership relation.
            if bytes.is_some() || tree.get(&owner.path).is_some_and(Option::is_some) {
                relations.insert(ResourceRelation {
                    kind: ResourceRelationKind::Ownership,
                    role,
                    from: owner.path,
                    to: target,
                });
            }
        }
        if source(path).is_some_and(|s| s.kind == "progress") {
            let Some(document) = bytes
                .as_ref()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(b).ok())
            else {
                continue;
            };
            let Some(kits) = document
                .get("rewardKits")
                .and_then(serde_json::Value::as_array)
            else {
                continue;
            };
            for kit in kits.iter().filter_map(serde_json::Value::as_str) {
                let reference = kit.trim();
                let stem = if reference.to_ascii_lowercase().ends_with(".kit") {
                    &reference[..reference.len() - 4]
                } else {
                    reference
                };
                let target = format!("src/gift/{stem}.kit");
                // Unresolved public references are useful facts. Invalid/private paths are
                // ignored rather than making unrelated resources uneditable.
                if !stem.is_empty() && path_ok(&target).is_ok() {
                    relations.insert(ResourceRelation {
                        kind: ResourceRelationKind::Reference,
                        role: ResourceRelationRole::RewardKit,
                        from: path.clone(),
                        to: target,
                    });
                }
            }
        }
    }
    relations.into_iter().collect()
}

pub(crate) fn related_to(relation: &ResourceRelation, path: &str) -> bool {
    nested(path, &relation.from)
        || nested(&relation.from, path)
        || nested(path, &relation.to)
        || nested(&relation.to, path)
}

pub(crate) fn relocated_owned(relation: &ResourceRelation, next_source: &Source) -> Option<String> {
    let (locale, _, _) = asset(&relation.to)?;
    Some(match relation.role {
        ResourceRelationRole::Language => format!(
            "assets/{locale}/lang_{}/{}.lang",
            next_source.kind, next_source.stem
        ),
        ResourceRelationRole::Voice => format!(
            "assets/{locale}/voice_{}/{}",
            next_source.kind, next_source.stem
        ),
        ResourceRelationRole::RewardKit => return None,
    })
}
