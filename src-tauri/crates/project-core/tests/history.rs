use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn open(root: &Path, now: u64) -> (Engine, String, String) {
    let mut engine = Engine::open_project(root).unwrap();
    let key = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, session) = engine.login(&key, "history-test", now).unwrap();
    (engine, session.id, key)
}
fn change(engine: &mut Engine, sid: &str, path: &str, bytes: &[u8], now: u64) -> FileChange {
    let version = engine
        .files_snapshot(sid)
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.path == path)
        .map(|entry| entry.version);
    let lease = engine
        .acquire_files(sid, &[path.into()], false, now)
        .unwrap()
        .remove(0);
    FileChange {
        op: "write".into(),
        path: path.into(),
        version,
        content: Some(STANDARD.encode(bytes)),
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    }
}
fn gzip_json(path: &Path) -> Value {
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(fs::File::open(path).unwrap())
        .read_to_end(&mut bytes)
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
fn revision(root: &Path, sequence: u64) -> PathBuf {
    root.join(format!(
        ".hanshu/service/history/revisions/{sequence:020}.json.gz"
    ))
}
fn transaction(root: &Path, id: &str) -> (PathBuf, Value) {
    fs::read_dir(root.join(".hanshu/service/file-transactions/archive"))
        .unwrap()
        .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
        .find_map(|entry| {
            let path = entry.unwrap().path();
            let value = gzip_json(&path);
            (value["receipt"]["transactionId"] == id).then_some((path, value))
        })
        .unwrap()
}

#[test]
fn baseline_contains_binary_and_empty_directories_but_never_service_credentials() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("assets/empty")).unwrap();
    fs::write(dir.path().join("assets/image.bin"), [0, 255, 1, 12]).unwrap();
    let (e, sid, _) = open(dir.path(), 1000);
    let page = e.history_list(&sid, None, 20, None).unwrap();
    assert_eq!(page.head, 1);
    assert_eq!(page.entries[0].kind, "baseline");
    assert!(page.entries[0].actor.is_none());
    let tree = e.history_tree(&sid, 1).unwrap();
    assert!(tree
        .entries
        .iter()
        .any(|entry| entry.path == "assets/empty" && entry.kind == "directory"));
    assert!(tree
        .entries
        .iter()
        .all(|entry| !entry.path.contains("service")));
    assert_eq!(
        STANDARD
            .decode(
                e.history_content(&sid, 1, "assets/image.bin")
                    .unwrap()
                    .content
            )
            .unwrap(),
        [0, 255, 1, 12]
    );
    assert!(e
        .history_content(&sid, 1, ".hanshu/service/owner-key")
        .is_err());
    assert!(e.history_content(&sid, 1, "assets/../owner-key").is_err());
    drop(e);
    let (e, sid, _) = open(dir.path(), 1000);
    assert_eq!(e.history_list(&sid, None, 1, None).unwrap().head, 1);
}

#[test]
fn actual_commits_are_attributed_deduplicated_and_retry_rejection_noop_do_not_add_versions() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(dir.path(), 1000);
    let a = change(&mut e, &sid, "assets/a.txt", b"same", 1000);
    let b = change(&mut e, &sid, "assets/b.txt", b"same", 1000);
    let original = vec![a, b];
    e.commit_files(&sid, "two-files", original.clone(), 1000)
        .unwrap();
    assert_eq!(e.history_stats(&sid).unwrap().objects, 1);
    assert_eq!(e.history_stats(&sid).unwrap().head, 2);
    let entry = e
        .history_list(&sid, None, 1, None)
        .unwrap()
        .entries
        .remove(0);
    assert_eq!(entry.actor.as_ref().unwrap().client_name, "history-test");
    assert_eq!(entry.transaction_id.as_deref(), Some("two-files"));
    e.commit_files(&sid, "two-files", original, 1000).unwrap();
    let no_op = change(&mut e, &sid, "assets/a.txt", b"same", 1000);
    e.commit_files(&sid, "noop", vec![no_op], 1000).unwrap();
    assert_eq!(
        e.commit_files(&sid, "bad", vec![], 1000).unwrap().status,
        FileTransactionStatus::Rejected
    );
    assert_eq!(e.history_stats(&sid).unwrap().head, 2);
    e.history_label(&sid, 2, Some("发布前".into()), 1000)
        .unwrap();
    let next = change(&mut e, &sid, "assets/a.txt", b"new", 1000);
    e.commit_files(&sid, "new", vec![next], 1000).unwrap();
    assert_eq!(
        e.history_list(&sid, Some(3), 1, None).unwrap().entries[0]
            .label
            .as_deref(),
        Some("发布前")
    );
    assert_eq!(
        e.history_content(&sid, 2, "assets/a.txt").unwrap().content,
        STANDARD.encode("same")
    );
    let (_, viewer_key) = e
        .create_subject(&sid, "Reader".into(), "agent".into(), Role::Viewer)
        .unwrap();
    let (_, viewer) = e.login(&viewer_key, "reader", 1000).unwrap();
    assert!(e.history_list(&viewer.id, None, 20, None).is_ok());
    assert_eq!(
        e.history_label(&viewer.id, 2, Some("No".into()), 1000)
            .unwrap_err()
            .code,
        "forbidden"
    );
    drop(e);
    let (e, sid, _) = open(dir.path(), 1000);
    assert_eq!(e.history_stats(&sid).unwrap().head, 3);
    assert_eq!(e.history_stats(&sid).unwrap().named_versions, 1);
}

#[test]
fn external_changes_are_recorded_before_user_changes_without_false_actor() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(dir.path(), 1000);
    fs::create_dir_all(dir.path().join("assets")).unwrap();
    fs::write(dir.path().join("assets/external.txt"), "outside").unwrap();
    let user = change(&mut e, &sid, "assets/user.txt", b"inside", 1000);
    e.commit_files(&sid, "user", vec![user], 1000).unwrap();
    let entries = e.history_list(&sid, None, 10, None).unwrap().entries;
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.kind.as_str())
            .collect::<Vec<_>>(),
        ["edit", "external", "baseline"]
    );
    assert!(entries[1].actor.is_none());
    assert!(entries[1].transaction_id.is_none());
    assert_eq!(
        e.history_content(&sid, 2, "assets/external.txt")
            .unwrap()
            .content,
        STANDARD.encode("outside")
    );
    assert!(e.history_content(&sid, 2, "assets/user.txt").is_err());
}

#[test]
fn moves_are_followed_across_filtered_pages_and_deleted_content_stays_readable() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(dir.path(), 1000);
    let a = change(&mut e, &sid, "assets/old.txt", b"A", 1000);
    e.commit_files(&sid, "create", vec![a], 1000).unwrap();
    let mut movement = change(&mut e, &sid, "assets/old.txt", b"", 1000);
    movement.op = "move".into();
    movement.content = None;
    movement.destination = Some("assets/new.txt".into());
    e.acquire_files(&sid, &["assets/new.txt".into()], false, 1000)
        .unwrap();
    e.commit_files(&sid, "move", vec![movement], 1000).unwrap();
    let mut remove = change(&mut e, &sid, "assets/new.txt", b"", 1000);
    remove.op = "remove".into();
    remove.content = None;
    e.commit_files(&sid, "remove", vec![remove], 1000).unwrap();
    let page = e
        .history_list(&sid, None, 2, Some("assets/new.txt"))
        .unwrap();
    assert_eq!(page.entries[0].sequence, 4);
    assert_eq!(page.entries[1].moves[0].from, "assets/old.txt");
    let older = e
        .history_list(&sid, page.next_before, 2, Some("assets/new.txt"))
        .unwrap();
    assert_eq!(older.entries[0].sequence, 2);
    assert_eq!(
        e.history_content(&sid, 2, "assets/old.txt")
            .unwrap()
            .content,
        STANDARD.encode("A")
    );
}

#[test]
fn groups_close_on_30_second_idle_5_minute_duration_and_destructive_operation() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, _, key) = open(dir.path(), 1000);
    let mut groups = Vec::new();
    for index in 0..=15 {
        let now = 1000 + index * 20_000;
        let (_, session) = e.login(&key, "continuous", now).unwrap();
        let write = change(
            &mut e,
            &session.id,
            "assets/a.txt",
            index.to_string().as_bytes(),
            now,
        );
        e.commit_files(&session.id, &format!("time-{index}"), vec![write], now)
            .unwrap();
        groups.push(e.history_list(&session.id, None, 1, None).unwrap().entries[0].group_id);
        e.logout(&session.id);
    }
    assert!(groups[..15].iter().all(|group| *group == groups[0]));
    assert_ne!(groups[15], groups[0]);
    let (_, session) = e.login(&key, "after-idle", 331_000).unwrap();
    let write = change(&mut e, &session.id, "assets/a.txt", b"after idle", 331_000);
    e.commit_files(&session.id, "idle", vec![write], 331_000)
        .unwrap();
    let idle_group = e.history_list(&session.id, None, 1, None).unwrap().entries[0].group_id;
    assert_ne!(idle_group, groups[15]);
    let mut remove = change(&mut e, &session.id, "assets/a.txt", b"", 331_000);
    remove.op = "remove".into();
    remove.content = None;
    e.commit_files(&session.id, "delete", vec![remove], 331_000)
        .unwrap();
    let entries = e.history_list(&session.id, None, 2, None).unwrap().entries;
    assert_ne!(entries[0].group_id, entries[1].group_id);
}

#[test]
fn committed_journal_publishes_exact_history_once_but_prepared_journal_never_does() {
    for committed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (mut e, sid, _) = open(dir.path(), 1000);
        let write = change(&mut e, &sid, "assets/a.txt", b"durable", 1000);
        e.commit_files(&sid, "pending", vec![write], 1000).unwrap();
        let (record_path, record) = transaction(dir.path(), "pending");
        let history = gzip_json(&revision(dir.path(), 2));
        drop(e);
        fs::remove_file(record_path).unwrap();
        fs::remove_file(revision(dir.path(), 2)).unwrap();
        fs::write(dir.path().join(".hanshu/service/file-undo.json"), serde_json::to_vec(&json!({
            "committed": committed, "transaction": record, "history": history,
            "undo": {"assets": {"kind":"missing","content":null}, "assets/a.txt":{"kind":"missing","content":null}}
        })).unwrap()).unwrap();
        let (e, sid, _) = open(dir.path(), 1000);
        assert_eq!(
            e.history_list(&sid, None, 20, None).unwrap().head,
            if committed { 2 } else { 1 }
        );
        assert_eq!(
            e.file_transaction(&sid, "pending").unwrap().status,
            if committed {
                FileTransactionStatus::Committed
            } else {
                FileTransactionStatus::Rejected
            }
        );
        drop(e);
        let (e, sid, _) = open(dir.path(), 1000);
        assert_eq!(
            e.history_list(&sid, None, 20, None).unwrap().head,
            if committed { 2 } else { 1 }
        );
    }
}

#[test]
fn corrupt_content_and_oversized_compressed_payloads_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(dir.path(), 1000);
    let write = change(&mut e, &sid, "assets/a.txt", b"before", 1000);
    e.commit_files(&sid, "write", vec![write], 1000).unwrap();
    let content = e.history_content(&sid, 2, "assets/a.txt").unwrap();
    let path = dir.path().join(format!(
        ".hanshu/service/history/objects/{}/{}.gz",
        &content.version[..2],
        content.version
    ));
    let mut compressed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    compressed.write_all(b"changed").unwrap();
    fs::write(&path, compressed.finish().unwrap()).unwrap();
    assert_eq!(
        e.history_content(&sid, 2, "assets/a.txt").unwrap_err().code,
        "storage"
    );
    let mut compressed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    compressed.write_all(&vec![0; 33 * 1024 * 1024]).unwrap();
    fs::write(&path, compressed.finish().unwrap()).unwrap();
    assert_eq!(
        e.history_content(&sid, 2, "assets/a.txt").unwrap_err().code,
        "storage"
    );
}

#[test]
fn source_history_includes_owned_languages_before_and_after_rename_but_not_reward_references() {
    let dir = tempfile::tempdir().unwrap();
    for (path, content) in [
        ("src/quest/a.quest", r#"{"rewardKits":["shared"]}"#),
        ("src/gift/shared.kit", "{}"),
        ("assets/zh_cn/lang_quest/a.lang", "title=A"),
    ] {
        let path = dir.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
    let (mut e, sid, _) = open(dir.path(), 1000);
    e.acquire_files(&sid, &["src/quest/a.quest".into()], false, 1000)
        .unwrap();
    let language = change(
        &mut e,
        &sid,
        "assets/zh_cn/lang_quest/a.lang",
        b"title=B",
        1000,
    );
    assert_eq!(
        e.commit_files(&sid, "language-only", vec![language], 1000)
            .unwrap()
            .status,
        FileTransactionStatus::Committed
    );
    let kit = change(
        &mut e,
        &sid,
        "src/gift/shared.kit",
        b"{\"changed\":true}",
        1000,
    );
    assert_eq!(
        e.commit_files(&sid, "referenced-kit", vec![kit], 1000)
            .unwrap()
            .status,
        FileTransactionStatus::Committed
    );
    let page = e
        .history_list(&sid, None, 20, Some("src/quest/a.quest"))
        .unwrap();
    assert!(page
        .entries
        .iter()
        .any(|entry| entry.transaction_id.as_deref() == Some("language-only")));
    assert!(!page
        .entries
        .iter()
        .any(|entry| entry.transaction_id.as_deref() == Some("referenced-kit")));
    let plan = e
        .plan_file_operations(
            &sid,
            &[FileOperationRequest {
                op: FileOperationKind::Move,
                path: "src/quest/a.quest".into(),
                destination: Some("src/quest/b.quest".into()),
            }],
        )
        .unwrap();
    let leases = e
        .acquire_files(&sid, &plan.lease_paths, false, 1000)
        .unwrap();
    let changes = plan
        .operations
        .iter()
        .map(|operation| FileChange {
            op: "move".into(),
            path: operation.path.clone(),
            version: operation.version.clone(),
            content: None,
            destination: operation.destination.clone(),
            destination_version: operation.destination_version.clone(),
            lease_id: leases
                .iter()
                .find(|lease| lease.resource_id == format!("file:{}", operation.path))
                .unwrap()
                .id
                .clone(),
        })
        .collect();
    assert_eq!(
        e.commit_files(&sid, "rename", changes, 1000)
            .unwrap()
            .status,
        FileTransactionStatus::Committed
    );
    let first = e
        .history_list(&sid, None, 1, Some("src/quest/b.quest"))
        .unwrap();
    assert_eq!(first.entries[0].transaction_id.as_deref(), Some("rename"));
    let older = e
        .history_list(&sid, first.next_before, 20, Some("src/quest/b.quest"))
        .unwrap();
    assert!(older
        .entries
        .iter()
        .any(|entry| entry.transaction_id.as_deref() == Some("language-only")));
    assert!(!older
        .entries
        .iter()
        .any(|entry| entry.transaction_id.as_deref() == Some("referenced-kit")));
    let scoped = e
        .history_tree_scoped(&sid, 2, Some("src/quest/b.quest"))
        .unwrap();
    assert_eq!(
        scoped.scope_path.as_deref(),
        Some("src/quest/a.quest")
    );
    assert_eq!(
        scoped
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>(),
        [
            "assets/zh_cn/lang_quest/a.lang",
            "src/quest/a.quest"
        ]
    );
    let language = e
        .history_tree_scoped(&sid, 2, Some("assets/zh_cn/lang_quest/b.lang"))
        .unwrap();
    assert_eq!(
        language.scope_path.as_deref(),
        Some("assets/zh_cn/lang_quest/a.lang")
    );
    assert_eq!(language.entries.len(), 1);
    let current = e
        .history_tree_scoped(&sid, 4, Some("src/quest/b.quest"))
        .unwrap();
    assert!(current
        .entries
        .iter()
        .any(|entry| entry.path == "src/quest/b.quest"));
    assert!(current
        .entries
        .iter()
        .all(|entry| !entry.path.contains("shared")));
}
