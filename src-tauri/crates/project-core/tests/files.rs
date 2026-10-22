use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use std::{fs, path::Path};

fn setup(root: &Path) -> (project_core::Engine, String) {
    let mut engine = project_core::Engine::open_project(root).unwrap();
    let credential = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, session) = engine.login(&credential, "test", 1000).unwrap();
    (engine, session.id)
}
fn commit(
    e: &mut project_core::Engine,
    sid: &str,
    changes: Vec<FileChange>,
    now: u64,
) -> Result<ProjectFileTree> {
    let receipt = e.commit_files(sid, &uuid::Uuid::new_v4().to_string(), changes, now)?;
    if let Some(error) = receipt.error {
        return Err(Error::new(
            match error.code.as_str() {
                "conflict" => "conflict",
                "locked" => "locked",
                "invalid" => "invalid",
                "forbidden" => "forbidden",
                "busy" => "busy",
                _ => "storage",
            },
            error.message,
        ));
    }
    Ok(receipt.tree.unwrap())
}

fn change(e: &mut project_core::Engine, sid: &str, path: &str, data: &str) -> FileChange {
    let version = e
        .files_snapshot(sid)
        .unwrap()
        .entries
        .iter()
        .find(|f| f.path == path)
        .map(|f| f.version.clone());
    let plan = e
        .plan_file_operations(
            sid,
            &[FileOperationRequest {
                op: FileOperationKind::Write,
                path: path.into(),
                destination: None,
            }],
        )
        .unwrap();
    let lease = e
        .acquire_files(sid, &plan.lease_paths, false, 1000)
        .unwrap()
        .into_iter()
        .find(|lease| lease.resource_id == format!("file:{path}"))
        .unwrap();
    FileChange {
        op: "write".into(),
        path: path.into(),
        version,
        content: Some(STANDARD.encode(data)),
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    }
}

#[test]
fn all_file_types_are_server_owned_and_stale_versions_cannot_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(dir.path());
    for path in [
        "src/hanshu/story.hs",
        "src/character/npc.char",
        "src/script/action.py",
        "src/goal/goal.py",
        "src/progress/quest.progress",
        "src/story/tree.hflow",
        "src/navigator/point.nav",
        "src/items/apple.item",
        "src/gift/reward.kit",
        "meta/docs/notes.md",
        "meta/voice/plan.tts",
        "meta/voice/service/provider.ttsservice",
        "assets/zh_cn/lang_hs/story.lang",
        "assets/sound.ogg",
        ".hanshu/skinmanager/library.json",
    ] {
        let content = if path == ".hanshu/skinmanager/library.json" {
            r#"{"schemaVersion":5,"revision":1,"folders":[],"entries":[]}"#
        } else if path.ends_with(".progress") {
            r#"{"format":"hanshu.progress","version":1,"id":"quest","name":"name","description":"description","tags":[],"completion":"all","goals":[],"visibility":[],"acceptance":[],"abandonable":true,"repeat":{"kind":"once"},"rewardKits":[]}"#
        } else {
            "original"
        };
        let c = change(&mut e, &sid, path, content);
        commit(&mut e, &sid, vec![c], 1000).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join(path)).unwrap(), content);
    }
    let stale = change(&mut e, &sid, "src/hanshu/story.hs", "stale");
    let next = change(&mut e, &sid, "src/hanshu/story.hs", "new");
    commit(&mut e, &sid, vec![next], 1000).unwrap();
    assert_eq!(
        commit(&mut e, &sid, vec![stale], 1000).unwrap_err().code,
        "conflict"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("src/hanshu/story.hs")).unwrap(),
        "new"
    );
}
#[test]
fn viewers_cannot_write_and_leases_are_bound_to_sessions_and_directories() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, owner) = setup(dir.path());
    let (_, key) = e
        .create_subject(&owner, "viewer".into(), "agent".into(), Role::Viewer)
        .unwrap();
    let (_, v) = e.login(&key, "viewer", 1000).unwrap();
    assert_eq!(
        e.acquire_files(&v.id, &["assets/a.png".into()], false, 1000)
            .unwrap_err()
            .code,
        "forbidden"
    );
    let (_, key) = e
        .create_subject(&owner, "editor".into(), "account".into(), Role::Editor)
        .unwrap();
    let (_, a) = e.login(&key, "A", 1000).unwrap();
    let (_, b) = e.login(&key, "B", 1000).unwrap();
    let c = change(&mut e, &a.id, "assets/a.png", "png");
    assert_eq!(
        commit(&mut e, &b.id, vec![c.clone()], 1000)
            .unwrap_err()
            .code,
        "locked"
    );
    commit(&mut e, &a.id, vec![c], 1000).unwrap();
    assert_eq!(
        e.acquire_files(&b.id, &["assets".into()], false, 1000)
            .unwrap_err()
            .code,
        "locked"
    );
    assert!(e
        .acquire_files(&b.id, &["assets/b.png".into()], false, 1000)
        .is_ok());
    e.acquire_files(&owner, &["assets/a.png".into()], true, 1000)
        .unwrap();
    let c = FileChange {
        op: "write".into(),
        path: "assets/a.png".into(),
        version: None,
        content: Some(STANDARD.encode("overwrite")),
        destination: None,
        destination_version: None,
        lease_id: "stolen".into(),
    };
    assert_eq!(
        commit(&mut e, &a.id, vec![c], 1000).unwrap_err().code,
        "locked"
    );
}
#[test]
fn traversal_service_secrets_and_case_collisions_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(dir.path());
    for path in [
        "../outside",
        "src/../../outside",
        "C:/Windows/test",
        "assets/a:stream",
        ".hanshu/service/owner-key",
        "assets/CON.txt",
        "assets/x.",
        "assets/a\\b",
    ] {
        assert!(
            e.acquire_files(&sid, &[path.into()], false, 1000).is_err(),
            "{path}"
        );
        assert!(e.read_project_file(&sid, path, None).is_err(), "{path}");
    }
    let a = change(&mut e, &sid, "assets/A.png", "A");
    commit(&mut e, &sid, vec![a], 1000).unwrap();
    let b = change(&mut e, &sid, "assets/a.png", "b");
    assert_eq!(
        commit(&mut e, &sid, vec![b], 1000).unwrap_err().code,
        "conflict"
    );
    assert!(e
        .files_snapshot(&sid)
        .unwrap()
        .entries
        .iter()
        .all(|e| !e.path.contains("service")));
}
#[test]
fn batches_validate_every_change_before_touching_disk_and_do_not_delete_omissions() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(dir.path());
    let a = change(&mut e, &sid, "src/hanshu/a.hs", "A");
    let b = change(&mut e, &sid, "src/hanshu/b.hs", "B");
    commit(&mut e, &sid, vec![a, b], 1000).unwrap();
    let a = change(&mut e, &sid, "src/hanshu/a.hs", "changed");
    let mut b = change(&mut e, &sid, "src/hanshu/b.hs", "invalid");
    b.version = Some("wrong".into());
    assert!(commit(&mut e, &sid, vec![a, b], 1000).is_err());
    assert_eq!(
        fs::read_to_string(dir.path().join("src/hanshu/a.hs")).unwrap(),
        "A"
    );
    let a = change(&mut e, &sid, "src/hanshu/a.hs", "changed");
    commit(&mut e, &sid, vec![a], 1000).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("src/hanshu/b.hs")).unwrap(),
        "B"
    );
}
#[test]
fn association_plan_is_derived_from_all_server_files() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(dir.path());
    for path in [
        "src/hanshu/a.hs",
        "assets/zh_cn/lang_hs/a.lang",
        "assets/en_us/voice_hs/a/line.ogg",
    ] {
        let c = change(&mut e, &sid, path, "x");
        commit(&mut e, &sid, vec![c], 1000).unwrap();
    }
    let plan = e
        .plan_file_operations(
            &sid,
            &[FileOperationRequest {
                op: FileOperationKind::Move,
                path: "src/hanshu/a.hs".into(),
                destination: Some("src/hanshu/b.hs".into()),
            }],
        )
        .unwrap();
    assert_eq!(plan.operations.len(), 3);
    assert!(plan
        .operations
        .iter()
        .any(|p| p.destination.as_deref() == Some("assets/en_us/voice_hs/b")));
    let mut removal = change(&mut e, &sid, "src/hanshu/a.hs", "");
    removal.op = "remove".into();
    removal.content = None;
    assert_eq!(
        commit(&mut e, &sid, vec![removal], 1000).unwrap_err().code,
        "invalid"
    );
}

#[test]
fn localizations_and_voice_share_the_source_write_authority() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, owner) = setup(dir.path());
    let (_, key) = e
        .create_subject(&owner, "editor".into(), "account".into(), Role::Editor)
        .unwrap();
    let (_, a) = e.login(&key, "A", 1000).unwrap();
    let (_, b) = e.login(&key, "B", 1000).unwrap();
    e.acquire_files(
        &a.id,
        &["src/progress/example.progress".into()],
        false,
        1000,
    )
    .unwrap();
    assert_eq!(
        e.acquire_files(
            &b.id,
            &e.plan_file_operations(
                &b.id,
                &[FileOperationRequest {
                    op: FileOperationKind::Write,
                    path: "assets/zh_cn/lang_progress/example.lang".into(),
                    destination: None
                }]
            )
            .unwrap()
            .lease_paths,
            false,
            1000
        )
        .unwrap_err()
        .code,
        "locked"
    );
    assert_eq!(
        e.acquire_files(
            &b.id,
            &e.plan_file_operations(
                &b.id,
                &[FileOperationRequest {
                    op: FileOperationKind::Write,
                    path: "assets/zh_cn/voice_progress/example/line.ogg".into(),
                    destination: None
                }]
            )
            .unwrap()
            .lease_paths,
            false,
            1000
        )
        .unwrap_err()
        .code,
        "locked"
    );
    assert!(e
        .acquire_files(&b.id, &["src/progress/other.progress".into()], false, 1000)
        .is_ok());
}
#[test]
fn failed_apply_rolls_back_and_crash_recovery_restores_files_and_empty_directories() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(dir.path());
    let c = change(&mut e, &sid, "assets/a.txt", "before");
    commit(&mut e, &sid, vec![c], 1000).unwrap();
    // Simulate a crash after partial application of a journaled transaction.
    drop(e);
    fs::write(dir.path().join("assets/a.txt"), "partial").unwrap();
    fs::create_dir_all(dir.path().join("assets/new/empty")).unwrap();
    fs::create_dir_all(dir.path().join("assets/old-empty")).unwrap();
    let journal = serde_json::json!({"assets/a.txt":{"kind":"file","content":STANDARD.encode("before")},"assets/new/empty":{"kind":"missing","content":null},"assets/new":{"kind":"missing","content":null},"assets/old-empty":{"kind":"directory","content":null}});
    fs::write(
        dir.path().join(".hanshu/service/file-undo.json"),
        serde_json::json!({
            "committed":false,
            "transaction":{"subjectId":"test-subject","requestDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "receipt":{"transactionId":"interrupted-test","status":"committed","tree":{"revision":3,"entries":[]},"error":null}},
            "undo":journal
        }).to_string(),
    )
    .unwrap();
    let (_e, _) = setup(dir.path());
    assert_eq!(
        fs::read_to_string(dir.path().join("assets/a.txt")).unwrap(),
        "before"
    );
    assert!(!dir.path().join("assets/new").exists());
    assert!(dir.path().join("assets/old-empty").is_dir());
}

#[cfg(windows)]
#[test]
fn failed_file_replacement_fences_reads_until_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(dir.path());
    for path in ["assets/a.txt", "assets/z_long_readonly_target.txt"] {
        let c = change(&mut e, &sid, path, "before");
        commit(&mut e, &sid, vec![c], 1000).unwrap();
    }
    let a = change(&mut e, &sid, "assets/a.txt", "after");
    let z = change(&mut e, &sid, "assets/z_long_readonly_target.txt", "after");
    let target = dir.path().join("assets/z_long_readonly_target.txt");
    let mut permissions = fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions).unwrap();
    let result = commit(&mut e, &sid, vec![a, z], 1000);
    let mut permissions = fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(false);
    fs::set_permissions(&target, permissions).unwrap();
    assert_eq!(result.unwrap_err().code, "storage");
    assert!(e.read_project_file(&sid, "assets/a.txt", None).is_err());
    drop(e);
    let (e, sid) = setup(dir.path());
    assert_eq!(
        e.read_project_file(&sid, "assets/a.txt", None).unwrap().0,
        b"before"
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "before");
    assert!(!dir.path().join(".hanshu/service/file-undo.json").exists());
}
