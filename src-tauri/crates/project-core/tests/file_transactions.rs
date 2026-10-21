use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn open(root: &Path) -> (project_core::Engine, String, String) {
    let mut engine = project_core::Engine::open_project(root).unwrap();
    let key = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, session) = engine.login(&key, "transaction-test", 1000).unwrap();
    (engine, session.id, key)
}

fn write(e: &mut project_core::Engine, sid: &str, path: &str, text: &str) -> FileChange {
    let version = e
        .files_snapshot(sid)
        .unwrap()
        .entries
        .into_iter()
        .find(|file| file.path == path)
        .map(|file| file.version);
    let lease = e
        .acquire_files(sid, &[path.into()], false, 1000)
        .unwrap()
        .into_iter()
        .find(|lease| lease.resource_id == format!("file:{path}"))
        .unwrap();
    FileChange {
        op: "write".into(),
        path: path.into(),
        version,
        content: Some(STANDARD.encode(text)),
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    }
}

fn stored(root: &Path, transaction: &str) -> (PathBuf, Value) {
    fs::read_dir(root.join(".hanshu/service/file-transactions"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|s| s.to_str()) == Some("json"))
        .find_map(|path| {
            let value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            (value["receipt"]["transactionId"] == transaction).then_some((path, value))
        })
        .unwrap()
}

#[test]
fn lost_reply_replay_ignores_renewed_lease_and_preserves_original_versions() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, key) = open(directory.path());
    let original = write(&mut e, &sid, "assets/a.txt", "one");
    let receipt = e
        .commit_files(&sid, "save-one", vec![original.clone()], 1000)
        .unwrap();
    assert_eq!(receipt.status, FileTransactionStatus::Committed);
    let newer = write(&mut e, &sid, "assets/a.txt", "two");
    let newer_receipt = e.commit_files(&sid, "save-two", vec![newer], 1000).unwrap();
    let (_, other_session) = e.login(&key, "reconnected", 1000).unwrap();
    let mut replay = original.clone();
    replay.lease_id = "expired-or-renewed-lease-is-not-request-identity".into();
    assert_eq!(
        e.commit_files(&other_session.id, "save-one", vec![replay], 1000)
            .unwrap(),
        receipt
    );
    assert_eq!(
        e.file_transaction(&other_session.id, "save-one").unwrap(),
        receipt
    );
    assert_ne!(newer_receipt.tree, receipt.tree);
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "two"
    );
    drop(e);
    let (mut e, sid, _) = open(directory.path());
    assert_eq!(e.file_transaction(&sid, "save-one").unwrap(), receipt);
    assert_eq!(
        e.commit_files(&sid, "save-one", vec![original], 1000)
            .unwrap(),
        receipt
    );
    assert_eq!(
        e.files_snapshot(&sid).unwrap().revision,
        newer_receipt.tree.unwrap().revision
    );
}

#[test]
fn transaction_id_binds_subject_and_payload_including_versions_and_operation_order() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, owner, _) = open(directory.path());
    let (_, key) = e
        .create_subject(&owner, "Editor".into(), "agent".into(), Role::Editor)
        .unwrap();
    let (_, editor) = e.login(&key, "editor", 1000).unwrap();
    let a = write(&mut e, &editor.id, "assets/a.txt", "one");
    let b = write(&mut e, &editor.id, "assets/b.txt", "two");
    let receipt = e
        .commit_files(
            &editor.id,
            "editor-transaction",
            vec![a.clone(), b.clone()],
            1000,
        )
        .unwrap();
    assert_eq!(
        e.file_transaction(&owner, "editor-transaction")
            .unwrap_err()
            .code,
        "forbidden"
    );
    assert_eq!(
        e.commit_files(
            &owner,
            "editor-transaction",
            vec![a.clone(), b.clone()],
            1000
        )
        .unwrap_err()
        .code,
        "forbidden"
    );
    assert_eq!(
        e.commit_files(
            &editor.id,
            "editor-transaction",
            vec![b.clone(), a.clone()],
            1000
        )
        .unwrap_err()
        .code,
        "conflict"
    );
    let mut changed = a.clone();
    changed.content = Some(STANDARD.encode("changed"));
    assert_eq!(
        e.commit_files(
            &editor.id,
            "editor-transaction",
            vec![changed, b.clone()],
            1000
        )
        .unwrap_err()
        .code,
        "conflict"
    );
    let mut changed = a;
    changed.version = Some("different-base".into());
    assert_eq!(
        e.commit_files(&editor.id, "editor-transaction", vec![changed, b], 1000)
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(
        e.file_transaction(&editor.id, "editor-transaction")
            .unwrap(),
        receipt
    );
    assert_eq!(
        e.file_transaction(&editor.id, "unknown").unwrap_err().code,
        "not_found"
    );
    assert_eq!(
        e.file_transaction(&editor.id, "../outside")
            .unwrap_err()
            .code,
        "invalid"
    );
}

#[test]
fn rejection_is_durable_and_retry_with_new_authority_requires_a_new_id() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let mut change = write(&mut e, &sid, "assets/a.txt", "one");
    let valid_lease = change.lease_id.clone();
    change.lease_id = "invalid".into();
    let receipt = e
        .commit_files(&sid, "rejected-attempt", vec![change.clone()], 1000)
        .unwrap();
    assert_eq!(receipt.status, FileTransactionStatus::Rejected);
    assert_eq!(receipt.error.as_ref().unwrap().code, "locked");
    assert!(!directory.path().join("assets/a.txt").exists());
    change.lease_id = valid_lease;
    assert_eq!(
        e.commit_files(&sid, "rejected-attempt", vec![change.clone()], 1000)
            .unwrap(),
        receipt
    );
    assert_eq!(
        e.commit_files(&sid, "new-attempt", vec![change], 1000)
            .unwrap()
            .status,
        FileTransactionStatus::Committed
    );
    drop(e);
    let (e, sid, _) = open(directory.path());
    assert_eq!(
        e.file_transaction(&sid, "rejected-attempt").unwrap(),
        receipt
    );
}

fn moved_file(root: &Path) -> (FileChange, FileTransactionReceipt, Value) {
    let (mut e, sid, _) = open(root);
    let initial = write(&mut e, &sid, "assets/before.txt", "original");
    e.commit_files(&sid, "initial", vec![initial], 1000)
        .unwrap();
    let mut movement = write(&mut e, &sid, "assets/before.txt", "");
    movement.op = "move".into();
    movement.content = None;
    movement.destination = Some("assets/after.txt".into());
    e.acquire_files(&sid, &["assets/after.txt".into()], false, 1000)
        .unwrap();
    let receipt = e
        .commit_files(&sid, "movement", vec![movement.clone()], 1000)
        .unwrap();
    let (path, record) = stored(root, "movement");
    drop(e);
    // Model termination between the journal decision and receipt persistence.
    fs::remove_file(path).unwrap();
    (movement, receipt, record)
}

fn interrupted_journal(root: &Path, committed: bool, record: Value) {
    fs::write(
        root.join(".hanshu/service/file-undo.json"),
        serde_json::to_vec(&serde_json::json!({
            "committed": committed, "transaction": record,
            "undo": {
                "assets/before.txt":{"kind":"file","content":STANDARD.encode("original")},
                "assets/after.txt":{"kind":"missing","content":null}
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn crash_after_commit_decision_publishes_receipt_without_replaying_destructive_operations() {
    let directory = tempfile::tempdir().unwrap();
    let (movement, expected, record) = moved_file(directory.path());
    interrupted_journal(directory.path(), true, record);
    let (mut e, sid, _) = open(directory.path());
    assert_eq!(e.file_transaction(&sid, "movement").unwrap(), expected);
    assert!(!directory.path().join("assets/before.txt").exists());
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/after.txt")).unwrap(),
        "original"
    );
    // A newly created source must survive a retry of the old move.
    let new_source = write(&mut e, &sid, "assets/before.txt", "new source");
    e.commit_files(&sid, "recreate-source", vec![new_source], 1000)
        .unwrap();
    assert_eq!(
        e.commit_files(&sid, "movement", vec![movement], 1000)
            .unwrap(),
        expected
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/before.txt")).unwrap(),
        "new source"
    );
    assert!(!directory
        .path()
        .join(".hanshu/service/file-undo.json")
        .exists());
}

#[test]
fn crash_before_commit_decision_rolls_back_then_publishes_rejection() {
    let directory = tempfile::tempdir().unwrap();
    let (movement, _, record) = moved_file(directory.path());
    interrupted_journal(directory.path(), false, record);
    let (mut e, sid, _) = open(directory.path());
    let receipt = e.file_transaction(&sid, "movement").unwrap();
    assert_eq!(receipt.status, FileTransactionStatus::Rejected);
    assert_eq!(receipt.error.as_ref().unwrap().code, "interrupted");
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/before.txt")).unwrap(),
        "original"
    );
    assert!(!directory.path().join("assets/after.txt").exists());
    assert_eq!(
        e.commit_files(&sid, "movement", vec![movement], 1000)
            .unwrap(),
        receipt
    );
    drop(e);
    let (e, sid, _) = open(directory.path());
    assert_eq!(e.file_transaction(&sid, "movement").unwrap(), receipt);
}

#[test]
fn case_distinct_transaction_ids_do_not_alias_on_windows() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let first = write(&mut e, &sid, "assets/a.txt", "one");
    let a = e.commit_files(&sid, "Case-ID", vec![first], 1000).unwrap();
    let next = write(&mut e, &sid, "assets/a.txt", "two");
    let b = e.commit_files(&sid, "case-id", vec![next], 1000).unwrap();
    drop(e);
    let (e, sid, _) = open(directory.path());
    assert_eq!(e.file_transaction(&sid, "Case-ID").unwrap(), a);
    assert_eq!(e.file_transaction(&sid, "case-id").unwrap(), b);
}

#[test]
fn receipt_capacity_rejects_new_attempts_without_forgetting_old_results() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let bad = FileChange {
        op: "write".into(),
        path: "assets/a.txt".into(),
        version: None,
        content: Some(STANDARD.encode("one")),
        destination: None,
        destination_version: None,
        lease_id: "none".into(),
    };
    let first = e
        .commit_files(&sid, "capacity-0", vec![bad.clone()], 1000)
        .unwrap();
    for index in 1..1024 {
        e.commit_files(&sid, &format!("capacity-{index}"), vec![bad.clone()], 1000)
            .unwrap();
    }
    assert_eq!(
        e.commit_files(&sid, "one-too-many", vec![bad.clone()], 1000)
            .unwrap_err()
            .code,
        "busy"
    );
    assert_eq!(e.file_transaction(&sid, "capacity-0").unwrap(), first);
    assert_eq!(
        e.commit_files(&sid, "capacity-0", vec![bad], 1000).unwrap(),
        first
    );
}

#[cfg(windows)]
#[test]
fn failed_disk_rollback_stays_uncertain_until_restart_records_a_rejection() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let short = write(&mut e, &sid, "assets/a.txt", "before");
    let long = write(&mut e, &sid, "assets/z_long_readonly.txt", "before");
    e.commit_files(&sid, "initial", vec![short, long], 1000)
        .unwrap();
    let short = write(&mut e, &sid, "assets/a.txt", "after");
    let long = write(&mut e, &sid, "assets/z_long_readonly.txt", "after");
    let target = directory.path().join("assets/z_long_readonly.txt");
    let mut permissions = fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions).unwrap();
    let result = e.commit_files(&sid, "disk-error", vec![short.clone(), long.clone()], 1000);
    let mut permissions = fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(false);
    fs::set_permissions(&target, permissions).unwrap();
    assert_eq!(result.unwrap_err().code, "storage");
    assert_eq!(
        e.file_transaction(&sid, "disk-error").unwrap_err().code,
        "storage"
    );
    assert!(e.read_project_file(&sid, "assets/a.txt", None).is_err());
    drop(e);
    let (mut e, sid, _) = open(directory.path());
    let receipt = e.file_transaction(&sid, "disk-error").unwrap();
    assert_eq!(receipt.status, FileTransactionStatus::Rejected);
    assert_eq!(receipt.error.as_ref().unwrap().code, "interrupted");
    assert_eq!(
        e.commit_files(&sid, "disk-error", vec![short, long], 1000)
            .unwrap(),
        receipt
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "before"
    );
    assert_eq!(fs::read_to_string(target).unwrap(), "before");
}

#[test]
fn crash_staging_is_private_and_startup_only_removes_owned_temporary_files() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let legitimate = write(&mut e, &sid, "assets/atomic-user-file.txt", "user asset");
    e.commit_files(&sid, "asset", vec![legitimate], 1000)
        .unwrap();
    drop(e);
    let staging = directory.path().join(".hanshu/service/write-staging");
    fs::write(staging.join("atomic-crash-leftover"), "incomplete write").unwrap();
    fs::write(staging.join("unrelated.txt"), "keep").unwrap();
    let (e, sid, _) = open(directory.path());
    assert!(!staging.join("atomic-crash-leftover").exists());
    assert!(staging.join("unrelated.txt").exists());
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/atomic-user-file.txt")).unwrap(),
        "user asset"
    );
    assert!(e
        .files_snapshot(&sid)
        .unwrap()
        .entries
        .iter()
        .all(|f| !f.path.contains("write-staging")));
}

#[test]
fn malformed_persistent_receipt_or_commit_decision_fails_closed() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let edit = write(&mut e, &sid, "assets/a.txt", "original");
    e.commit_files(&sid, "valid", vec![edit], 1000).unwrap();
    let (path, mut record) = stored(directory.path(), "valid");
    drop(e);
    record["receipt"]["tree"] = Value::Null;
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    assert_eq!(
        project_core::Engine::open_project(directory.path())
            .err()
            .unwrap()
            .code,
        "storage"
    );

    let directory = tempfile::tempdir().unwrap();
    let (_, _, mut record) = moved_file(directory.path());
    record["receipt"]["status"] = Value::String("rejected".into());
    record["receipt"]["tree"] = Value::Null;
    record["receipt"]["error"] =
        serde_json::json!({"code":"conflict","message":"inconsistent journal"});
    interrupted_journal(directory.path(), true, record);
    assert_eq!(
        project_core::Engine::open_project(directory.path())
            .err()
            .unwrap()
            .code,
        "storage"
    );
    assert!(!directory.path().join("assets/before.txt").exists());
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/after.txt")).unwrap(),
        "original"
    );
}

fn check(e: &mut project_core::Engine, sid: &str, path: &str) -> FileChange {
    let mut edit = write(e, sid, path, "");
    edit.op = "check".into();
    edit.content = None;
    edit
}

#[test]
fn read_set_checks_cover_existing_missing_and_directory_versions() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let initial = write(&mut e, &sid, "assets/group/a.txt", "original");
    e.commit_files(&sid, "initial", vec![initial], 1000)
        .unwrap();
    let existing = check(&mut e, &sid, "assets/group/a.txt");
    let absent = check(&mut e, &sid, "assets/missing.txt");
    let folder = check(&mut e, &sid, "assets/group");
    let receipt = e
        .commit_files(
            &sid,
            "all-checks",
            vec![existing.clone(), absent.clone(), folder.clone()],
            1000,
        )
        .unwrap();
    assert_eq!(receipt.status, FileTransactionStatus::Committed);
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/group/a.txt")).unwrap(),
        "original"
    );
    assert!(!directory.path().join("assets/missing.txt").exists());

    let changed = write(&mut e, &sid, "assets/group/a.txt", "new");
    let appeared = write(&mut e, &sid, "assets/missing.txt", "now exists");
    e.commit_files(&sid, "new-values", vec![changed, appeared], 1000)
        .unwrap();
    for (index, stale) in [existing, absent, folder].into_iter().enumerate() {
        let receipt = e
            .commit_files(&sid, &format!("stale-check-{index}"), vec![stale], 1000)
            .unwrap();
        assert_eq!(receipt.status, FileTransactionStatus::Rejected);
        assert_eq!(receipt.error.unwrap().code, "conflict");
    }
}

#[test]
fn mixed_check_and_write_is_atomic_and_check_requires_its_own_lease() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let a = write(&mut e, &sid, "assets/a.txt", "A");
    let b = write(&mut e, &sid, "assets/b.txt", "B");
    e.commit_files(&sid, "initial", vec![a, b], 1000).unwrap();
    let before = check(&mut e, &sid, "assets/b.txt");
    let mut invalid_lease = before.clone();
    invalid_lease.lease_id = "expired".into();
    let a = write(&mut e, &sid, "assets/a.txt", "should not land");
    let receipt = e
        .commit_files(&sid, "wrong-lease", vec![a, invalid_lease], 1000)
        .unwrap();
    assert_eq!(receipt.error.unwrap().code, "locked");

    let b = write(&mut e, &sid, "assets/b.txt", "B2");
    e.commit_files(&sid, "remote-change", vec![b], 1000)
        .unwrap();
    let a = write(&mut e, &sid, "assets/a.txt", "should not land");
    let receipt = e
        .commit_files(&sid, "stale-mixed", vec![a, before], 1000)
        .unwrap();
    assert_eq!(receipt.error.unwrap().code, "conflict");
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "A"
    );

    let a = write(&mut e, &sid, "assets/a.txt", "A2");
    let current = check(&mut e, &sid, "assets/b.txt");
    let receipt = e
        .commit_files(&sid, "valid-mixed", vec![a, current], 1000)
        .unwrap();
    assert_eq!(receipt.status, FileTransactionStatus::Committed);
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "A2"
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/b.txt")).unwrap(),
        "B2"
    );
}
