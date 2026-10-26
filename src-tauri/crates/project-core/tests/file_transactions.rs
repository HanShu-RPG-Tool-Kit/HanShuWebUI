use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
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
    fs::read_dir(root.join(".hanshu/service/file-transactions/archive"))
        .unwrap()
        .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
        .map(|entry| entry.unwrap().path())
        .find_map(|path| {
            let mut bytes = Vec::new();
            flate2::read::GzDecoder::new(fs::File::open(&path).unwrap())
                .read_to_end(&mut bytes)
                .unwrap();
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            (value["receipt"]["transactionId"] == transaction).then_some((path, value))
        })
        .unwrap()
}

fn write_archive(path: &Path, record: &Value) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(&serde_json::to_vec(record).unwrap())
        .unwrap();
    let bytes = encoder.finish().unwrap();
    fs::write(path, &bytes).unwrap();
    bytes
}

fn quarantine(root: &Path) -> PathBuf {
    root.join(".hanshu/service/file-transactions/archive-quarantine")
}

fn quarantined_evidence(root: &Path, source: &Path) -> (PathBuf, PathBuf) {
    let hash = source
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .trim_end_matches(".json.gz");
    (
        quarantine(root).join(format!("{hash}.tombstone.json")),
        quarantine(root).join(source.file_name().unwrap()),
    )
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
    evict_hot_receipts(&mut e, &editor.id);
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
fn more_than_1024_commits_remain_writable_and_evicted_receipts_stay_exact_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let original = write(&mut e, &sid, "assets/a.txt", "one");
    let first = e
        .commit_files(&sid, "capacity-0", vec![original.clone()], 1000)
        .unwrap();
    for index in 1..1100 {
        let change = write(&mut e, &sid, "assets/a.txt", &format!("value {index}"));
        let receipt = e
            .commit_files(&sid, &format!("capacity-{index}"), vec![change], 1000)
            .unwrap();
        assert_eq!(receipt.status, FileTransactionStatus::Committed);
    }
    assert_eq!(e.file_transaction(&sid, "capacity-0").unwrap(), first);
    assert_eq!(
        e.commit_files(&sid, "capacity-0", vec![original.clone()], 1000)
            .unwrap(),
        first
    );
    drop(e);
    let (mut e, sid, _) = open(directory.path());
    assert_eq!(e.file_transaction(&sid, "capacity-0").unwrap(), first);
    assert_eq!(
        e.commit_files(&sid, "capacity-0", vec![original], 1000)
            .unwrap(),
        first
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "value 1099"
    );
    let next = write(&mut e, &sid, "assets/a.txt", "after restart");
    assert_eq!(
        e.commit_files(&sid, "after-restart", vec![next], 1000)
            .unwrap()
            .status,
        FileTransactionStatus::Committed
    );
}

fn evict_hot_receipts(e: &mut project_core::Engine, sid: &str) {
    for index in 0..70 {
        let rejected = e
            .commit_files(sid, &format!("eviction-{index}"), vec![], 1000)
            .unwrap();
        assert_eq!(rejected.status, FileTransactionStatus::Rejected);
    }
}

#[test]
fn cold_move_and_delete_replays_never_touch_recreated_resources() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let a = write(&mut e, &sid, "assets/before.txt", "A");
    let b = write(&mut e, &sid, "assets/delete.txt", "B");
    e.commit_files(&sid, "initial", vec![a, b], 1000).unwrap();
    let mut movement = write(&mut e, &sid, "assets/before.txt", "");
    movement.op = "move".into();
    movement.content = None;
    movement.destination = Some("assets/after.txt".into());
    e.acquire_files(&sid, &["assets/after.txt".into()], false, 1000)
        .unwrap();
    let mut removal = write(&mut e, &sid, "assets/delete.txt", "");
    removal.op = "remove".into();
    removal.content = None;
    let edits = vec![movement, removal];
    let receipt = e
        .commit_files(&sid, "destructive", edits.clone(), 1000)
        .unwrap();
    let recreated_a = write(&mut e, &sid, "assets/before.txt", "new A");
    let recreated_b = write(&mut e, &sid, "assets/delete.txt", "new B");
    e.commit_files(&sid, "recreated", vec![recreated_a, recreated_b], 1000)
        .unwrap();
    evict_hot_receipts(&mut e, &sid);
    assert_eq!(
        e.commit_files(&sid, "destructive", edits.clone(), 1000)
            .unwrap(),
        receipt
    );
    drop(e);
    let (mut e, sid, _) = open(directory.path());
    assert_eq!(
        e.commit_files(&sid, "destructive", edits, 1000).unwrap(),
        receipt
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/before.txt")).unwrap(),
        "new A"
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/delete.txt")).unwrap(),
        "new B"
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/after.txt")).unwrap(),
        "A"
    );
}

#[test]
fn old_json_receipts_migrate_and_duplicate_copies_after_interruption_are_safe() {
    for archive_already_published in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (mut e, sid, _) = open(directory.path());
        let edit = write(&mut e, &sid, "assets/a.txt", "original");
        let expected = e
            .commit_files(&sid, "legacy", vec![edit.clone()], 1000)
            .unwrap();
        let (archive, record) = stored(directory.path(), "legacy");
        drop(e);
        let legacy = directory
            .path()
            .join(".hanshu/service/file-transactions")
            .join(archive.file_stem().unwrap());
        fs::write(&legacy, serde_json::to_vec(&record).unwrap()).unwrap();
        if !archive_already_published {
            fs::remove_file(&archive).unwrap();
        }
        let (mut e, sid, _) = open(directory.path());
        assert!(!legacy.exists());
        assert!(archive.exists());
        assert_eq!(e.file_transaction(&sid, "legacy").unwrap(), expected);
        assert_eq!(
            e.commit_files(&sid, "legacy", vec![edit], 1000).unwrap(),
            expected
        );
        assert_eq!(
            e.files_snapshot(&sid).unwrap().revision,
            expected.tree.unwrap().revision
        );
    }
}

#[test]
fn inconsistent_legacy_and_archive_copies_fail_closed_without_deleting_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    e.commit_files(&sid, "legacy-conflict", vec![], 1000)
        .unwrap();
    let (archive, mut record) = stored(directory.path(), "legacy-conflict");
    drop(e);
    record["receipt"]["error"]["message"] = Value::String("different immutable outcome".into());
    let legacy = directory
        .path()
        .join(".hanshu/service/file-transactions")
        .join(archive.file_stem().unwrap());
    fs::write(&legacy, serde_json::to_vec(&record).unwrap()).unwrap();
    assert_eq!(
        Engine::open_project(directory.path()).err().unwrap().code,
        "storage"
    );
    assert!(legacy.exists());
    assert!(archive.exists());
}

#[test]
fn corrupted_cold_receipt_is_never_treated_as_an_unknown_id() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let edit = write(&mut e, &sid, "assets/a.txt", "original");
    let committed = e
        .commit_files(&sid, "cold", vec![edit.clone()], 1000)
        .unwrap();
    let (path, _) = stored(directory.path(), "cold");
    evict_hot_receipts(&mut e, &sid);
    fs::write(&path, b"incomplete archive").unwrap();
    assert_eq!(
        e.file_transaction(&sid, "cold").unwrap_err().code,
        "storage"
    );
    assert_eq!(
        e.commit_files(&sid, "cold", vec![edit.clone()], 1000)
            .unwrap_err()
            .code,
        "storage"
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "original"
    );
    drop(e);
    let (mut e, sid, _) = open(directory.path());
    assert_eq!(
        e.file_transaction(&sid, "cold").unwrap_err().code,
        "receipt_quarantined"
    );
    assert_eq!(
        e.commit_files(&sid, "cold", vec![edit], 1000)
            .unwrap_err()
            .code,
        "receipt_quarantined"
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "original"
    );
    assert!(e.files_snapshot(&sid).unwrap().revision >= committed.tree.unwrap().revision);
    let next = write(&mut e, &sid, "assets/a.txt", "new transaction");
    assert_eq!(
        e.commit_files(&sid, "after-quarantine", vec![next], 1000)
            .unwrap()
            .status,
        FileTransactionStatus::Committed
    );
    let (marker, evidence) = quarantined_evidence(directory.path(), &path);
    assert!(marker.is_file());
    assert_eq!(fs::read(evidence).unwrap(), b"incomplete archive");
    assert!(!path.exists());
}

#[test]
fn blocked_archive_publication_preserves_committed_journal_until_storage_is_repaired() {
    let directory = tempfile::tempdir().unwrap();
    let (movement, expected, record) = moved_file(directory.path());
    interrupted_journal(directory.path(), true, record);
    // The committed decision exists, but archive publication is unavailable.
    let archive = directory
        .path()
        .join(".hanshu/service/file-transactions/archive");
    let backup = directory.path().join("archive-backup");
    fs::rename(&archive, &backup).unwrap();
    fs::write(&archive, b"blocked by a file").unwrap();
    assert_eq!(
        Engine::open_project(directory.path()).err().unwrap().code,
        "storage"
    );
    assert!(directory
        .path()
        .join(".hanshu/service/file-undo.json")
        .exists());
    // A later resource is deliberately created before recovery. Replaying the
    // old move would destroy it, while publishing the original receipt will not.
    fs::write(directory.path().join("assets/before.txt"), "new source").unwrap();
    fs::remove_file(&archive).unwrap();
    fs::rename(backup, archive).unwrap();
    let (mut e, sid, _) = open(directory.path());
    assert_eq!(e.file_transaction(&sid, "movement").unwrap(), expected);
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
fn contradictory_prepared_journal_never_rolls_back_a_committed_archive() {
    let directory = tempfile::tempdir().unwrap();
    let (_, expected, record) = moved_file(directory.path());
    interrupted_journal(directory.path(), true, record.clone());
    let (e, sid, _) = open(directory.path());
    assert_eq!(e.file_transaction(&sid, "movement").unwrap(), expected);
    drop(e);
    interrupted_journal(directory.path(), false, record);
    assert_eq!(
        Engine::open_project(directory.path()).err().unwrap().code,
        "storage"
    );
    assert!(!directory.path().join("assets/before.txt").exists());
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/after.txt")).unwrap(),
        "original"
    );
    assert!(directory
        .path()
        .join(".hanshu/service/file-undo.json")
        .exists());
}

#[test]
fn unavailable_archive_refuses_new_changes_before_mutation() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let edit = write(&mut e, &sid, "assets/a.txt", "must not land yet");
    let archive = directory
        .path()
        .join(".hanshu/service/file-transactions/archive");
    fs::remove_dir(&archive).unwrap();
    fs::write(&archive, b"unavailable").unwrap();
    assert_eq!(
        e.commit_files(&sid, "unavailable", vec![edit.clone()], 1000)
            .unwrap_err()
            .code,
        "storage"
    );
    assert!(!directory.path().join("assets/a.txt").exists());
    assert!(!directory
        .path()
        .join(".hanshu/service/file-undo.json")
        .exists());
    fs::remove_file(&archive).unwrap();
    fs::create_dir(&archive).unwrap();
    assert_eq!(
        e.commit_files(&sid, "unavailable", vec![edit], 1000)
            .unwrap()
            .status,
        FileTransactionStatus::Committed
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
fn malformed_historical_receipt_is_quarantined_but_commit_decision_fails_closed() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let edit = write(&mut e, &sid, "assets/a.txt", "original");
    e.commit_files(&sid, "valid", vec![edit], 1000).unwrap();
    let (path, mut record) = stored(directory.path(), "valid");
    drop(e);
    record["receipt"]["tree"] = Value::Null;
    let damaged = write_archive(&path, &record);
    let before = inspect_transaction_archives(directory.path()).unwrap();
    let entry = before
        .entries
        .iter()
        .find(|entry| entry.transaction_id.as_deref() == Some("valid"))
        .unwrap();
    assert_eq!(entry.status, "corrupt");
    assert_eq!(entry.code.as_deref(), Some("invalid_record"));
    assert_eq!(before.stats.corrupt_count, 1);
    assert_eq!(fs::read(&path).unwrap(), damaged);
    assert!(!quarantine(directory.path()).exists());
    let (e, sid, _) = open(directory.path());
    assert_eq!(
        e.file_transaction(&sid, "valid").unwrap_err().code,
        "receipt_quarantined"
    );
    let (marker, evidence) = quarantined_evidence(directory.path(), &path);
    assert!(marker.is_file());
    assert_eq!(fs::read(evidence).unwrap(), damaged);
    let after = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(after.stats.quarantined_count, 1);
    assert_eq!(after.stats.corrupt_count, 0);
    assert_eq!(after.entries[0].transaction_id.as_deref(), Some("valid"));
    assert_eq!(after.entries[0].status, "quarantined");
    drop(e);

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
    assert!(directory
        .path()
        .join(".hanshu/service/file-undo.json")
        .is_file());
    assert!(!quarantine(directory.path()).exists());
}

fn check(e: &mut project_core::Engine, sid: &str, path: &str) -> FileChange {
    let mut edit = write(e, sid, path, "");
    edit.op = "check".into();
    edit.content = None;
    edit
}

fn disk_snapshot(root: &Path) -> Vec<(PathBuf, bool, Vec<u8>, Option<std::time::SystemTime>)> {
    fn visit(
        root: &Path,
        directory: &Path,
        out: &mut Vec<(PathBuf, bool, Vec<u8>, Option<std::time::SystemTime>)>,
    ) {
        for entry in fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert!(!metadata.file_type().is_symlink());
            out.push((
                path.strip_prefix(root).unwrap().to_owned(),
                metadata.is_dir(),
                if metadata.is_file() {
                    fs::read(&path).unwrap()
                } else {
                    Vec::new()
                },
                metadata.modified().ok(),
            ));
            if metadata.is_dir() {
                visit(root, &path, out);
            }
        }
    }
    let mut out = Vec::new();
    visit(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn archive_diagnostics_are_read_only_and_count_mixed_legacy_and_compressed_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let empty = inspect_transaction_archives(directory.path()).unwrap();
    assert!(empty.entries.is_empty());
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);

    let (mut e, sid, _) = open(directory.path());
    for id in ["compressed", "legacy-offline", "broken-offline"] {
        e.commit_files(&sid, id, vec![], 1000).unwrap();
    }
    let (compressed, _) = stored(directory.path(), "compressed");
    let (legacy_archive, legacy_record) = stored(directory.path(), "legacy-offline");
    let (broken, _) = stored(directory.path(), "broken-offline");
    drop(e);
    let legacy = directory
        .path()
        .join(".hanshu/service/file-transactions")
        .join(legacy_archive.file_stem().unwrap());
    let legacy_bytes = serde_json::to_vec(&legacy_record).unwrap();
    fs::write(&legacy, &legacy_bytes).unwrap();
    fs::remove_file(legacy_archive).unwrap();
    fs::write(&broken, b"not gzip").unwrap();
    let before = disk_snapshot(directory.path());
    let report = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(disk_snapshot(directory.path()), before);
    assert_eq!(report.entries.len(), 3);
    assert_eq!(report.stats.archive_count, 2);
    assert_eq!(report.stats.legacy_count, 1);
    assert_eq!(report.stats.valid_count, 2);
    assert_eq!(report.stats.corrupt_count, 1);
    assert_eq!(report.stats.quarantined_count, 0);
    assert_eq!(
        report.stats.protected_count + report.stats.unsafe_count + report.stats.io_error_count,
        0
    );
    assert_eq!(
        report.stats.compressed_bytes,
        fs::metadata(&compressed).unwrap().len() + legacy_bytes.len() as u64 + 8
    );
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(fs::File::open(compressed).unwrap())
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(
        report.stats.uncompressed_bytes,
        decoded.len() as u64 + legacy_bytes.len() as u64
    );
    assert!(report.scanned_at_ms > 0);
    assert!(report.stats.oldest_modified_at_ms.is_some());
    assert!(report.stats.oldest_modified_at_ms <= report.stats.newest_modified_at_ms);
    assert!(report
        .entries
        .iter()
        .all(|entry| !Path::new(&entry.relative_path).is_absolute()));
    let damaged = report
        .entries
        .iter()
        .find(|entry| entry.status == "corrupt")
        .unwrap();
    assert_eq!(damaged.transaction_id, None);
    assert_eq!(damaged.code.as_deref(), Some("invalid_gzip"));
    assert!(damaged
        .message
        .as_deref()
        .is_some_and(|message| !message.is_empty()));
}

#[test]
fn corrupt_archive_required_by_prepared_or_committed_journal_is_never_quarantined() {
    for committed in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (_, expected, record) = moved_file(directory.path());
        interrupted_journal(directory.path(), true, record.clone());
        let (e, sid, _) = open(directory.path());
        assert_eq!(e.file_transaction(&sid, "movement").unwrap(), expected);
        let (archive, _) = stored(directory.path(), "movement");
        drop(e);
        interrupted_journal(directory.path(), committed, record);
        fs::write(&archive, b"damaged recovery dependency").unwrap();
        let before = disk_snapshot(directory.path());
        let report = inspect_transaction_archives(directory.path()).unwrap();
        assert_eq!(disk_snapshot(directory.path()), before);
        assert_eq!(report.stats.protected_count, 1);
        assert_eq!(report.stats.corrupt_count, 0);
        let entry = report
            .entries
            .iter()
            .find(|entry| entry.status == "protected")
            .unwrap();
        assert_eq!(entry.code.as_deref(), Some("recovery_receipt_corrupt"));
        assert_eq!(
            Engine::open_project(directory.path()).err().unwrap().code,
            "storage"
        );
        assert_eq!(fs::read(&archive).unwrap(), b"damaged recovery dependency");
        assert!(directory
            .path()
            .join(".hanshu/service/file-undo.json")
            .is_file());
        assert!(!quarantine(directory.path()).exists());
        assert!(!directory.path().join("assets/before.txt").exists());
        assert_eq!(
            fs::read_to_string(directory.path().join("assets/after.txt")).unwrap(),
            "original"
        );
    }
}

#[test]
fn unsafe_archive_structure_prevents_quarantine_of_other_bad_contents() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    e.commit_files(&sid, "corrupt-with-unsafe-sibling", vec![], 1000)
        .unwrap();
    let (archive, _) = stored(directory.path(), "corrupt-with-unsafe-sibling");
    drop(e);
    fs::write(&archive, b"bad history").unwrap();
    let obstruction = directory
        .path()
        .join(".hanshu/service/file-transactions/archive/not-a-shard");
    fs::write(&obstruction, b"preserve this structural evidence").unwrap();
    let report = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(report.stats.corrupt_count, 1);
    assert_eq!(report.stats.unsafe_count, 1);
    assert_eq!(
        Engine::open_project(directory.path()).err().unwrap().code,
        "storage"
    );
    assert_eq!(fs::read(archive).unwrap(), b"bad history");
    assert_eq!(
        fs::read(obstruction).unwrap(),
        b"preserve this structural evidence"
    );
    assert!(!quarantine(directory.path()).exists());
}

#[test]
fn archive_identity_mismatch_is_unsafe_and_preserves_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    e.commit_files(&sid, "named-record", vec![], 1000).unwrap();
    let (archive, mut record) = stored(directory.path(), "named-record");
    drop(e);
    record["receipt"]["transactionId"] = Value::String("different-record".into());
    let evidence = write_archive(&archive, &record);
    let report = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(report.stats.unsafe_count, 1);
    assert_eq!(report.stats.corrupt_count, 0);
    assert_eq!(
        report.entries[0].code.as_deref(),
        Some("receipt_identity_mismatch")
    );
    assert_eq!(
        Engine::open_project(directory.path()).err().unwrap().code,
        "storage"
    );
    assert_eq!(fs::read(archive).unwrap(), evidence);
    assert!(!quarantine(directory.path()).exists());
}

#[cfg(windows)]
#[test]
fn archive_read_io_failure_is_not_content_corruption_and_never_quarantined() {
    use std::os::windows::fs::OpenOptionsExt;
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    e.commit_files(&sid, "locked-archive", vec![], 1000)
        .unwrap();
    let (archive, _) = stored(directory.path(), "locked-archive");
    drop(e);
    let evidence = fs::read(&archive).unwrap();
    let handle = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&archive)
        .unwrap();
    let report = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(report.stats.io_error_count, 1);
    assert_eq!(report.stats.corrupt_count, 0);
    assert_eq!(
        Engine::open_project(directory.path()).err().unwrap().code,
        "storage"
    );
    assert!(!quarantine(directory.path()).exists());
    drop(handle);
    assert_eq!(fs::read(&archive).unwrap(), evidence);
    let (e, sid, _) = open(directory.path());
    assert_eq!(
        e.file_transaction(&sid, "locked-archive").unwrap().status,
        FileTransactionStatus::Rejected
    );
}

#[test]
fn quarantine_resumes_after_tombstone_publication_without_releasing_the_id() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let original = write(&mut e, &sid, "assets/a.txt", "original");
    e.commit_files(&sid, "quarantine-interrupted", vec![original.clone()], 1000)
        .unwrap();
    let (archive, _) = stored(directory.path(), "quarantine-interrupted");
    drop(e);
    fs::write(&archive, b"damaged before quarantine").unwrap();
    let (e, sid, _) = open(directory.path());
    assert_eq!(
        e.file_transaction(&sid, "quarantine-interrupted")
            .unwrap_err()
            .code,
        "receipt_quarantined"
    );
    drop(e);
    let (marker, evidence) = quarantined_evidence(directory.path(), &archive);
    let marker_bytes = fs::read(&marker).unwrap();
    // Model a crash after publishing the tombstone but before moving its payload.
    fs::rename(&evidence, &archive).unwrap();
    let before = disk_snapshot(directory.path());
    let report = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(disk_snapshot(directory.path()), before);
    assert!(report
        .entries
        .iter()
        .any(|entry| entry.status == "quarantined"));
    let (mut e, sid, _) = open(directory.path());
    assert!(!archive.exists());
    assert_eq!(fs::read(&evidence).unwrap(), b"damaged before quarantine");
    assert_eq!(fs::read(&marker).unwrap(), marker_bytes);
    assert_eq!(
        e.file_transaction(&sid, "quarantine-interrupted")
            .unwrap_err()
            .code,
        "receipt_quarantined"
    );
    assert_eq!(
        e.commit_files(&sid, "quarantine-interrupted", vec![original], 1000)
            .unwrap_err()
            .code,
        "receipt_quarantined"
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "original"
    );
    let report = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(report.stats.quarantined_count, 1);
    assert_eq!(report.stats.corrupt_count, 0);
}

#[test]
fn damaged_quarantine_tombstone_fails_closed_without_reexecuting_the_transaction() {
    let directory = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    let original = write(&mut e, &sid, "assets/a.txt", "original");
    e.commit_files(&sid, "damaged-marker", vec![original.clone()], 1000)
        .unwrap();
    let newer = write(&mut e, &sid, "assets/a.txt", "newer content");
    e.commit_files(&sid, "after-damaged-marker", vec![newer], 1000)
        .unwrap();
    let (archive, _) = stored(directory.path(), "damaged-marker");
    drop(e);
    fs::write(&archive, b"retained damaged payload").unwrap();
    let (mut e, sid, _) = open(directory.path());
    let (marker, evidence) = quarantined_evidence(directory.path(), &archive);
    fs::write(&marker, b"truncated marker").unwrap();
    // The live engine holds a Windows byte-range lock on service.lock; inspect
    // the archive subtree here, while offline tests compare the entire project.
    let transaction_directory = directory.path().join(".hanshu/service/file-transactions");
    let before = disk_snapshot(&transaction_directory);
    let report = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(disk_snapshot(&transaction_directory), before);
    assert_eq!(report.stats.unsafe_count, 1);
    let unsafe_entry = report
        .entries
        .iter()
        .find(|entry| entry.status == "unsafe")
        .unwrap();
    assert_eq!(unsafe_entry.code.as_deref(), Some("invalid_tombstone"));
    assert_eq!(
        e.file_transaction(&sid, "damaged-marker").unwrap_err().code,
        "storage"
    );
    assert_eq!(
        e.commit_files(&sid, "damaged-marker", vec![original], 1000)
            .unwrap_err()
            .code,
        "storage"
    );
    drop(e);
    assert_eq!(
        Engine::open_project(directory.path()).err().unwrap().code,
        "storage"
    );
    assert_eq!(fs::read(&marker).unwrap(), b"truncated marker");
    assert_eq!(fs::read(&evidence).unwrap(), b"retained damaged payload");
    assert!(!archive.exists());
    assert_eq!(
        fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
        "newer content"
    );
}

#[test]
fn archive_tree_paths_outside_public_resources_are_unsafe_and_never_quarantined() {
    for invalid_path in ["../outside", ".hanshu/service/secret"] {
        let directory = tempfile::tempdir().unwrap();
        let (mut e, sid, _) = open(directory.path());
        let original = write(&mut e, &sid, "assets/a.txt", "preserved resource");
        e.commit_files(&sid, "unsafe-tree", vec![original], 1000)
            .unwrap();
        let (archive, mut record) = stored(directory.path(), "unsafe-tree");
        drop(e);
        let file = record["receipt"]["tree"]["entries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|file| file["path"] == "assets/a.txt")
            .unwrap();
        file["path"] = Value::String(invalid_path.into());
        let evidence = write_archive(&archive, &record);
        let before = disk_snapshot(directory.path());
        let report = inspect_transaction_archives(directory.path()).unwrap();
        assert_eq!(disk_snapshot(directory.path()), before);
        assert_eq!(report.stats.unsafe_count, 1);
        assert_eq!(report.stats.corrupt_count, 0);
        let entry = report
            .entries
            .iter()
            .find(|entry| entry.transaction_id.as_deref() == Some("unsafe-tree"))
            .unwrap();
        assert_eq!(entry.status, "unsafe");
        assert_eq!(entry.code.as_deref(), Some("unsafe_receipt_path"));
        assert_eq!(
            Engine::open_project(directory.path()).err().unwrap().code,
            "storage"
        );
        assert_eq!(fs::read(&archive).unwrap(), evidence);
        assert!(!quarantine(directory.path()).exists());
        assert_eq!(
            fs::read_to_string(directory.path().join("assets/a.txt")).unwrap(),
            "preserved resource"
        );
    }
}

#[cfg(unix)]
#[test]
fn archive_symlink_is_not_followed_or_quarantined() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = open(directory.path());
    e.commit_files(&sid, "linked-archive", vec![], 1000)
        .unwrap();
    let (archive, _) = stored(directory.path(), "linked-archive");
    drop(e);
    let target = external.path().join("untouchable.json.gz");
    fs::rename(&archive, &target).unwrap();
    let evidence = fs::read(&target).unwrap();
    symlink(&target, &archive).unwrap();
    let report = inspect_transaction_archives(directory.path()).unwrap();
    assert_eq!(report.stats.unsafe_count, 1);
    assert_eq!(report.stats.corrupt_count, 0);
    assert_eq!(
        Engine::open_project(directory.path()).err().unwrap().code,
        "storage"
    );
    assert!(fs::symlink_metadata(&archive)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(target).unwrap(), evidence);
    assert!(!quarantine(directory.path()).exists());
}

#[test]
fn quarantining_latest_receipt_preserves_revision_and_allows_new_commits() {
    for legacy_without_watermark in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let (mut e, sid, _) = open(directory.path());
        let mut latest = 0;
        for index in 0..5 {
            let edit = write(&mut e, &sid, "assets/a.txt", &format!("value {index}"));
            latest = e
                .commit_files(&sid, &format!("revision-{index}"), vec![edit], 1000)
                .unwrap()
                .tree
                .unwrap()
                .revision;
        }
        let (archive, _) = stored(directory.path(), "revision-4");
        drop(e);
        if legacy_without_watermark {
            let watermark = directory
                .path()
                .join(".hanshu/service/file-transactions/revision-watermark");
            assert!(watermark.exists());
            fs::remove_file(watermark).unwrap();
        }
        fs::write(&archive, b"damaged newest receipt").unwrap();
        let (mut e, sid, _) = open(directory.path());
        let reopened = e.files_snapshot(&sid).unwrap().revision;
        assert!(
            reopened >= latest,
            "revision regressed from {latest} to {reopened}"
        );
        let edit = write(&mut e, &sid, "assets/a.txt", "after recovery");
        let next = e
            .commit_files(&sid, "revision-after-recovery", vec![edit], 1000)
            .unwrap()
            .tree
            .unwrap()
            .revision;
        assert!(next > reopened);
        drop(e);
        let (e, sid, _) = open(directory.path());
        assert!(e.files_snapshot(&sid).unwrap().revision >= next);
        assert_eq!(
            e.file_transaction(&sid, "revision-4").unwrap_err().code,
            "receipt_quarantined"
        );
    }
}

#[test]
fn progress_undo_of_quarantined_receipt_stays_unknown_and_other_undo_still_works() {
    let directory = tempfile::tempdir().unwrap();
    const SOURCE: &str = "src/quest/quest.quest";
    fs::create_dir_all(directory.path().join("src/quest")).unwrap();
    fs::write(directory.path().join(SOURCE), serde_json::to_vec(&serde_json::json!({
        "format":"hanshu.progress","version":1,"id":"document-1","name":"name","description":"description",
        "tags":[],"completion":"all","goals":[],"visibility":[],"acceptance":[],"abandonable":true,
        "autoStartWhenAcceptable":false,"repeat":{"kind":"once"},"rewardKits":[]
    })).unwrap()).unwrap();
    let change = |body: Value| FileChange {
        op: "progress-command".into(),
        path: SOURCE.into(),
        version: None,
        content: Some(STANDARD.encode(serde_json::to_vec(&body).unwrap())),
        destination: None,
        destination_version: None,
        lease_id: String::new(),
    };
    let apply_field = |field: &str, expected: Value, value: Value| {
        change(serde_json::json!({
            "command":"apply","documentId":"document-1","changes":[{
                "target":{"kind":"field","field":field},
                "expected":{"present":true,"value":expected},"value":{"present":true,"value":value}
            }]
        }))
    };
    let (mut e, sid, _) = open(directory.path());
    let first = e
        .commit_files(
            &sid,
            "progress-damaged",
            vec![apply_field(
                "completion",
                Value::String("all".into()),
                Value::String("any".into()),
            )],
            1000,
        )
        .unwrap();
    assert_eq!(first.status, FileTransactionStatus::Committed);
    let second = e
        .commit_files(
            &sid,
            "progress-healthy",
            vec![apply_field(
                "abandonable",
                Value::Bool(true),
                Value::Bool(false),
            )],
            1000,
        )
        .unwrap();
    assert_eq!(second.status, FileTransactionStatus::Committed);
    let (archive, _) = stored(directory.path(), "progress-damaged");
    drop(e);
    fs::write(archive, b"lost progress receipt").unwrap();
    let (mut e, sid, _) = open(directory.path());
    let before = fs::read(directory.path().join(SOURCE)).unwrap();
    let undone = e
        .commit_files(
            &sid,
            "undo-damaged",
            vec![change(serde_json::json!({
                "command":"revert","transactionId":"progress-damaged"
            }))],
            1000,
        )
        .unwrap_err();
    assert_eq!(undone.code, "receipt_quarantined");
    assert_eq!(
        e.file_transaction(&sid, "undo-damaged").unwrap_err().code,
        "not_found"
    );
    assert_eq!(fs::read(directory.path().join(SOURCE)).unwrap(), before);
    let healthy = e
        .commit_files(
            &sid,
            "undo-healthy",
            vec![change(serde_json::json!({
                "command":"revert","transactionId":"progress-healthy"
            }))],
            1000,
        )
        .unwrap();
    assert_eq!(healthy.status, FileTransactionStatus::Committed);
    let document: Value =
        serde_json::from_slice(&fs::read(directory.path().join(SOURCE)).unwrap()).unwrap();
    assert_eq!(document["completion"], "any");
    assert_eq!(document["abandonable"], true);
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
