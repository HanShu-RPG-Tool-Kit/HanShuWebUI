use project_core::*;
use std::{fs, path::Path};

fn login(e: &mut Engine, root: &Path) -> (String, String) {
    let key = fs::read_to_string(root.join("owner-key")).unwrap();
    let (token, s) = e.login(&key, "test", 1000).unwrap();
    (token, s.id)
}
fn progress() -> String {
    serde_json::json!({"format":"hanshu.progress","version":1,"id":"doc","name":"测试","description":"","authorNotes":"","tags":[],"completion":"all","goals":[],"visibility":[],"acceptance":[],"abandonable":true,"autoStartWhenAcceptable":false,"repeat":{"kind":"once"},"rewardKits":[]}).to_string()
}

#[test]
fn identity_is_not_a_connection_and_leases_are_session_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = Engine::open(dir.path()).unwrap();
    let (_, owner) = login(&mut e, dir.path());
    let (subject, key) = e
        .create_subject(
            &owner,
            "构建机器人".into(),
            "automation".into(),
            Role::Editor,
        )
        .unwrap();
    let (_, a) = e.login(&key, "browser A", 1000).unwrap();
    let (_, b) = e.login(&key, "browser B", 1000).unwrap();
    assert_eq!(a.subject_id, subject.id);
    assert_eq!(a.subject_id, b.subject_id);
    assert_ne!(a.id, b.id);
    let r = e
        .create_resource(
            &a.id,
            None,
            "one.progress".into(),
            ResourceKind::Progress,
            Some(progress()),
        )
        .unwrap();
    let l = e.acquire(&a.id, &r.id, false, 1000).unwrap();
    assert_eq!(
        e.acquire(&b.id, &r.id, false, 1000).unwrap_err().code,
        "locked"
    );
    assert_eq!(
        e.save(&b.id, &r.id, &l.id, 1, progress(), 1000)
            .unwrap_err()
            .code,
        "locked"
    );
    e.heartbeat(&a.id, Some(r.id.clone()), Some(&l.id), true, 1500)
        .unwrap();
    assert_eq!(
        e.snapshot(&a.id)
            .unwrap()
            .sessions
            .iter()
            .find(|s| s.id == a.id)
            .unwrap()
            .activity,
        "typing"
    );
}

#[test]
fn viewers_and_revoked_subjects_cannot_bypass_authority() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = Engine::open(dir.path()).unwrap();
    let (_, owner) = login(&mut e, dir.path());
    let (subject, key) = e
        .create_subject(&owner, "观察者".into(), "account".into(), Role::Viewer)
        .unwrap();
    let (token, v) = e.login(&key, "viewer", 1000).unwrap();
    let r = e
        .create_resource(
            &owner,
            None,
            "one.progress".into(),
            ResourceKind::Progress,
            Some(progress()),
        )
        .unwrap();
    assert!(e.resource(&v.id, &r.id).is_ok());
    assert_eq!(
        e.acquire(&v.id, &r.id, false, 1000).unwrap_err().code,
        "forbidden"
    );
    assert_eq!(
        e.create_resource(&v.id, None, "folder".into(), ResourceKind::Folder, None)
            .unwrap_err()
            .code,
        "forbidden"
    );
    assert_eq!(
        e.create_subject(&v.id, "X".into(), "agent".into(), Role::Editor)
            .unwrap_err()
            .code,
        "forbidden"
    );
    e.update_subject(&owner, &subject.id, Role::Viewer, false)
        .unwrap();
    assert_eq!(
        e.authenticate(&token, 1001).unwrap_err().code,
        "unauthorized"
    );
}

#[test]
fn lease_expiry_takeover_versions_and_restart_fence_old_writes() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = Engine::open(dir.path()).unwrap();
    let (_, owner) = login(&mut e, dir.path());
    let key = fs::read_to_string(dir.path().join("owner-key")).unwrap();
    let (_, b) = e.login(&key, "second", 1000).unwrap();
    let r = e
        .create_resource(
            &owner,
            None,
            "one.progress".into(),
            ResourceKind::Progress,
            Some(progress()),
        )
        .unwrap();
    let old = e.acquire(&owner, &r.id, false, 1000).unwrap();
    let next = e.acquire(&b.id, &r.id, true, 1001).unwrap();
    assert_ne!(old.id, next.id);
    assert_eq!(
        e.save(&owner, &r.id, &old.id, 1, progress(), 1002)
            .unwrap_err()
            .code,
        "locked"
    );
    let saved = e.save(&b.id, &r.id, &next.id, 1, progress(), 1002).unwrap();
    assert_eq!(saved.revision, 2);
    assert_eq!(
        e.save(&b.id, &r.id, &next.id, 1, progress(), 1003)
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(
        e.save(&b.id, &r.id, &next.id, 2, progress(), 1002 + LEASE_TTL)
            .unwrap_err()
            .code,
        "locked"
    );
    drop(e);
    let mut e = Engine::open(dir.path()).unwrap();
    let (_, owner) = login(&mut e, dir.path());
    assert_eq!(e.resource(&owner, &r.id).unwrap().revision, 2);
    assert!(e.snapshot(&owner).unwrap().leases.is_empty());
    assert_eq!(
        e.save(&owner, &r.id, &next.id, 2, progress(), 1002)
            .unwrap_err()
            .code,
        "locked"
    );
}

#[test]
fn malformed_writes_and_invalid_directory_changes_preserve_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = Engine::open(dir.path()).unwrap();
    let (_, owner) = login(&mut e, dir.path());
    let folder = e
        .create_resource(&owner, None, "folder".into(), ResourceKind::Folder, None)
        .unwrap();
    let r = e
        .create_resource(
            &owner,
            Some(folder.id.clone()),
            "one.progress".into(),
            ResourceKind::Progress,
            Some(progress()),
        )
        .unwrap();
    let l = e.acquire(&owner, &r.id, false, 1000).unwrap();
    assert!(e.save(&owner, &r.id, &l.id, 1, "{}".into(), 1000).is_err());
    assert_eq!(e.resource(&owner, &r.id).unwrap().revision, 1);
    assert_eq!(
        e.rename(
            &owner,
            &folder.id,
            None,
            1,
            Some(folder.id.clone()),
            "folder".into(),
            1000
        )
        .unwrap_err()
        .code,
        "invalid"
    );
    assert_eq!(
        e.rename(&owner, &folder.id, None, 1, None, "renamed".into(), 1000)
            .unwrap_err()
            .code,
        "locked"
    );
    assert!(e
        .create_resource(&owner, None, "../escape".into(), ResourceKind::Folder, None)
        .is_err());
    assert!(Engine::open(dir.path()).is_err());
}

#[test]
fn failed_disk_replacement_never_publishes_candidate_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = Engine::open(dir.path()).unwrap();
    let (_, owner) = login(&mut e, dir.path());
    let r = e
        .create_resource(
            &owner,
            None,
            "one.progress".into(),
            ResourceKind::Progress,
            Some(progress()),
        )
        .unwrap();
    let lease = e.acquire(&owner, &r.id, false, 1000).unwrap();
    let original = fs::read(dir.path().join("project.json")).unwrap();
    fs::rename(
        dir.path().join("project.json"),
        dir.path().join("before.json"),
    )
    .unwrap();
    fs::create_dir(dir.path().join("project.json")).unwrap();
    assert_eq!(
        e.save(&owner, &r.id, &lease.id, 1, progress(), 1001)
            .unwrap_err()
            .code,
        "storage"
    );
    assert_eq!(e.resource(&owner, &r.id).unwrap().revision, 1);
    assert_eq!(fs::read(dir.path().join("before.json")).unwrap(), original);
}

#[test]
fn duplicate_document_and_nested_config_keys_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = Engine::open(dir.path()).unwrap();
    let (_, owner) = login(&mut e, dir.path());
    let duplicate = progress().replace("\"name\":", "\"name\":\"discarded\",\"name\":");
    assert!(e
        .create_resource(
            &owner,
            None,
            "duplicate.progress".into(),
            ResourceKind::Progress,
            Some(duplicate)
        )
        .is_err());
    let duplicate = progress().replace(
        "\"goals\":[]",
        "\"goals\":[{\"id\":\"g\",\"kind\":\"counter\",\"config\":{\"count\":1,\"count\":2}}]",
    );
    assert!(e
        .create_resource(
            &owner,
            None,
            "nested.progress".into(),
            ResourceKind::Progress,
            Some(duplicate)
        )
        .is_err());
    assert!(e.snapshot(&owner).unwrap().resources.is_empty());
}

#[test]
fn expression_conditions_match_the_progress_editor_contract() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = Engine::open(dir.path()).unwrap();
    let (_, owner) = login(&mut e, dir.path());
    let mut doc: serde_json::Value = serde_json::from_str(&progress()).unwrap();
    for field in ["visibility", "acceptance"] {
        doc[field] = serde_json::json!([{"kind":"expr","state":"true","target":"level >= 5"}]);
    }
    e.create_resource(
        &owner,
        None,
        "expr.progress".into(),
        ResourceKind::Progress,
        Some(doc.to_string()),
    )
    .unwrap();
    doc["acceptance"][0]["state"] = serde_json::json!("false");
    assert!(e
        .create_resource(
            &owner,
            None,
            "invalid.progress".into(),
            ResourceKind::Progress,
            Some(doc.to_string())
        )
        .is_err());
    assert_eq!(e.snapshot(&owner).unwrap().resources.len(), 1);
}
