use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use serde_json::{json, Value};
use std::io::Read;
use std::{fs, path::Path};

const SOURCE: &str = "src/progress/quest.progress";
const LANG: &str = "assets/zh_cn/lang_progress/quest.lang";

fn document() -> Value {
    json!({"format":"hanshu.progress","version":1,"id":"document-1","name":"name","description":"description",
        "tags":[],"completion":"all","goals":[{"id":"goal-a","kind":"kill","config":{"count":1,"target":"pig"}},{"id":"goal-b","kind":"collect","config":{}}],
        "visibility":[],"acceptance":[],"abandonable":true,"repeat":{"kind":"once"},"rewardKits":[],"extension":{"keep":true}})
}
fn setup(root: &Path) -> (Engine, String, String) {
    fs::create_dir_all(root.join("src/progress")).unwrap();
    fs::create_dir_all(root.join("assets/zh_cn/lang_progress")).unwrap();
    fs::write(root.join(SOURCE), serde_json::to_vec(&document()).unwrap()).unwrap();
    fs::write(
        root.join(LANG),
        br#"{"name":"before","description":"untouched"}"#,
    )
    .unwrap();
    let mut engine = Engine::open_project(root).unwrap();
    let key = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, session) = engine.login(&key, "progress-test", 1000).unwrap();
    (engine, session.id, key)
}
fn change(body: Value) -> FileChange {
    FileChange {
        op: "progress-command".into(),
        path: SOURCE.into(),
        version: None,
        content: Some(STANDARD.encode(serde_json::to_vec(&body).unwrap())),
        destination: None,
        destination_version: None,
        lease_id: String::new(),
    }
}
fn command(engine: &mut Engine, sid: &str, body: Value) -> FileTransactionReceipt {
    engine
        .commit_files(
            sid,
            &uuid::Uuid::new_v4().to_string(),
            vec![change(body)],
            1000,
        )
        .unwrap()
}
fn apply(effects: Vec<Value>) -> Value {
    json!({"command":"apply","documentId":"document-1","changes":effects})
}
fn effect(target: Value, expected: Value, value: Value) -> Value {
    json!({"target":target,"expected":{"present":true,"value":expected},"value":{"present":true,"value":value}})
}
fn count(expected: u64, value: u64) -> Value {
    effect(
        json!({"kind":"goal-config","goalId":"goal-a","goalKind":"kill","key":"count"}),
        json!(expected),
        json!(value),
    )
}
fn field(field: &str, expected: Value, value: Value) -> Value {
    effect(json!({"kind":"field","field":field}), expected, value)
}
fn ok(receipt: &FileTransactionReceipt) {
    assert_eq!(
        receipt.status,
        FileTransactionStatus::Committed,
        "{receipt:?}"
    );
    assert!(receipt.progress_result.is_some());
}
fn rejected(receipt: &FileTransactionReceipt, code: &str) {
    assert_eq!(
        receipt.status,
        FileTransactionStatus::Rejected,
        "{receipt:?}"
    );
    assert_eq!(receipt.error.as_ref().unwrap().code, code, "{receipt:?}");
    assert!(receipt.progress_result.is_none());
}
fn read(root: &Path, path: &str) -> Value {
    serde_json::from_slice(&fs::read(root.join(path)).unwrap()).unwrap()
}

#[test]
fn disjoint_fields_merge_and_selective_undo_preserves_peer_edits_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid, key) = setup(dir.path());
    let first = command(&mut engine, &sid, apply(vec![count(1, 2)]));
    ok(&first);
    let peer = command(
        &mut engine,
        &sid,
        apply(vec![field("completion", json!("all"), json!("any"))]),
    );
    ok(&peer);
    let stale = command(&mut engine, &sid, apply(vec![count(1, 9)]));
    rejected(&stale, "conflict");
    assert!(engine.snapshot(&sid).unwrap().leases.is_empty());
    drop(engine);
    let mut engine = Engine::open_project(dir.path()).unwrap();
    let (_, session) = engine.login(&key, "reconnected", 1000).unwrap();
    let undone = command(
        &mut engine,
        &session.id,
        json!({"command":"revert","transactionId":first.transaction_id}),
    );
    ok(&undone);
    let doc = read(dir.path(), SOURCE);
    assert_eq!(doc["goals"][0]["config"]["count"], 1);
    assert_eq!(doc["completion"], "any");
    assert_eq!(doc["extension"]["keep"], true);
    let redone = command(
        &mut engine,
        &session.id,
        json!({"command":"revert","transactionId":undone.transaction_id}),
    );
    ok(&redone);
    assert_eq!(read(dir.path(), SOURCE)["goals"][0]["config"]["count"], 2);
}

#[test]
fn source_and_locale_commit_atomically_and_noop_does_not_create_history() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid, key) = setup(dir.path());
    let (_, peer) = engine.login(&key, "other-window", 1000).unwrap();
    let lease = engine
        .acquire_files(&peer.id, &[LANG.into()], false, 1000)
        .unwrap()
        .remove(0);
    let edits = apply(vec![
        count(1, 2),
        effect(
            json!({"kind":"locale","locale":"zh_cn","key":"name"}),
            json!("before"),
            json!("after"),
        ),
    ]);
    rejected(&command(&mut engine, &sid, edits.clone()), "locked");
    assert_eq!(read(dir.path(), SOURCE)["goals"][0]["config"]["count"], 1);
    assert_eq!(read(dir.path(), LANG)["name"], "before");
    assert_eq!(engine.snapshot(&sid).unwrap().leases.len(), 1);
    engine
        .release(&peer.id, &lease.resource_id, &lease.id, 1000)
        .unwrap();
    let saved = command(&mut engine, &sid, edits);
    ok(&saved);
    assert_eq!(saved.progress_result.as_ref().unwrap().languages.len(), 1);
    assert_eq!(read(dir.path(), LANG)["description"], "untouched");
    let head = engine.history_stats(&sid).unwrap().head;
    let noop = command(&mut engine, &sid, apply(vec![count(2, 2)]));
    ok(&noop);
    assert!(noop.progress_result.unwrap().effects.is_empty());
    assert_eq!(engine.history_stats(&sid).unwrap().head, head);
}

#[test]
fn defaults_and_explicit_values_remain_distinct_and_document_identity_is_immutable() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid, _) = setup(dir.path());
    let initial = json!({"target":{"kind":"goal-config","goalId":"goal-b","goalKind":"collect","key":"count"},"expected":{"present":false,"value":null},"value":{"present":true,"value":1}});
    let saved = command(&mut engine, &sid, apply(vec![initial]));
    ok(&saved);
    assert_eq!(read(dir.path(), SOURCE)["goals"][1]["config"]["count"], 1);
    ok(&command(
        &mut engine,
        &sid,
        json!({"command":"revert","transactionId":saved.transaction_id}),
    ));
    assert!(read(dir.path(), SOURCE)["goals"][1]["config"]
        .get("count")
        .is_none());
    rejected(
        &command(
            &mut engine,
            &sid,
            apply(vec![field("id", json!("document-1"), json!("new-id"))]),
        ),
        "invalid",
    );
    let normalized = command(
        &mut engine,
        &sid,
        apply(vec![
            field("authorNotes", json!(""), json!("notes")),
            field(
                "repeat",
                json!({"kind":"once","hours":24}),
                json!({"kind":"manual","hours":24}),
            ),
        ]),
    );
    ok(&normalized);
    assert_eq!(read(dir.path(), SOURCE)["repeat"], json!({"kind":"manual"}));
}

#[test]
fn add_remove_and_order_use_initial_guards_and_undo_does_not_overwrite_goal_changes() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid, _) = setup(dir.path());
    let insert = json!({"target":{"kind":"goal","goalId":"goal-c"},"expected":{"present":false,"value":null},"value":{"present":true,"value":{"id":"goal-c","kind":"new","config":{}}}});
    let order = effect(
        json!({"kind":"goal-order"}),
        json!(["goal-a", "goal-b"]),
        json!(["goal-c", "goal-b", "goal-a"]),
    );
    let saved = command(&mut engine, &sid, apply(vec![order, insert.clone()]));
    ok(&saved);
    assert_eq!(read(dir.path(), SOURCE)["goals"][0]["id"], "goal-c");
    ok(&command(&mut engine, &sid, apply(vec![count(1, 2)])));
    ok(&command(
        &mut engine,
        &sid,
        json!({"command":"revert","transactionId":saved.transaction_id}),
    ));
    assert_eq!(read(dir.path(), SOURCE)["goals"][0]["config"]["count"], 2);
    let malformed = effect(
        json!({"kind":"goal-order"}),
        json!(["goal-a", "goal-b"]),
        json!(["goal-a", "goal-b"]),
    );
    rejected(
        &command(&mut engine, &sid, apply(vec![insert, malformed])),
        "invalid",
    );
    assert_eq!(
        read(dir.path(), SOURCE)["goals"].as_array().unwrap().len(),
        2
    );
}

#[test]
fn overlapping_fields_duplicate_json_and_arbitrary_paths_are_rejected_without_writes() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid, _) = setup(dir.path());
    let before = fs::read(dir.path().join(SOURCE)).unwrap();
    rejected(
        &command(&mut engine, &sid, apply(vec![count(1, 2), count(1, 3)])),
        "invalid",
    );
    rejected(
        &command(
            &mut engine,
            &sid,
            apply(vec![
                count(1, 2),
                effect(
                    json!({"kind":"goal-body","goalId":"goal-a"}),
                    json!({"kind":"kill","config":{"count":1,"target":"pig"}}),
                    json!({"kind":"collect","config":{}}),
                ),
            ]),
        ),
        "invalid",
    );
    rejected(
        &command(
            &mut engine,
            &sid,
            apply(vec![effect(
                json!({"kind":"locale","locale":"../../secret","key":"name"}),
                json!("before"),
                json!("after"),
            )]),
        ),
        "invalid",
    );
    let mut duplicate = change(json!({}));
    duplicate.content = Some(
        STANDARD.encode(br#"{"command":"apply","command":"revert","transactionId":"anything"}"#),
    );
    rejected(
        &engine
            .commit_files(&sid, "duplicate-json", vec![duplicate], 1000)
            .unwrap(),
        "invalid",
    );
    assert_eq!(fs::read(dir.path().join(SOURCE)).unwrap(), before);
    assert!(engine.snapshot(&sid).unwrap().leases.is_empty());
}

#[test]
fn replay_keeps_exact_receipt_and_other_subjects_cannot_revert_it() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid, _) = setup(dir.path());
    let saved = engine
        .commit_files(
            &sid,
            "stable-command",
            vec![change(apply(vec![count(1, 2)]))],
            1000,
        )
        .unwrap();
    ok(&saved);
    ok(&command(&mut engine, &sid, apply(vec![count(2, 3)])));
    let replayed = engine
        .commit_files(
            &sid,
            "stable-command",
            vec![change(apply(vec![count(1, 2)]))],
            1000,
        )
        .unwrap();
    assert_eq!(replayed, saved);
    assert_eq!(read(dir.path(), SOURCE)["goals"][0]["config"]["count"], 3);
    rejected(
        &command(
            &mut engine,
            &sid,
            json!({"command":"revert","transactionId":"stable-command"}),
        ),
        "conflict",
    );
    let (_, key) = engine
        .create_subject(&sid, "peer".into(), "account".into(), Role::Editor)
        .unwrap();
    let (_, peer) = engine.login(&key, "peer", 1000).unwrap();
    rejected(
        &command(
            &mut engine,
            &peer.id,
            json!({"command":"revert","transactionId":"stable-command"}),
        ),
        "forbidden",
    );
}

#[test]
fn recovery_publishes_selective_undo_only_after_the_durable_commit_decision() {
    fn gzip_json(path: &Path) -> Value {
        let mut bytes = Vec::new();
        flate2::read::GzDecoder::new(fs::File::open(path).unwrap())
            .read_to_end(&mut bytes)
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
    for committed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (mut engine, sid, key) = setup(dir.path());
        let original = fs::read(dir.path().join(SOURCE)).unwrap();
        let receipt = engine
            .commit_files(
                &sid,
                "crash-progress",
                vec![change(apply(vec![count(1, 2)]))],
                1000,
            )
            .unwrap();
        ok(&receipt);
        let archive = fs::read_dir(dir.path().join(".hanshu/service/file-transactions/archive"))
            .unwrap()
            .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
            .map(|entry| entry.unwrap().path())
            .find(|path| gzip_json(path)["receipt"]["transactionId"] == "crash-progress")
            .unwrap();
        let transaction = gzip_json(&archive);
        let history_path = dir
            .path()
            .join(".hanshu/service/history/revisions/00000000000000000002.json.gz");
        let history = gzip_json(&history_path);
        drop(engine);
        fs::remove_file(&archive).unwrap();
        fs::remove_file(&history_path).unwrap();
        fs::write(
            dir.path().join(".hanshu/service/file-undo.json"),
            serde_json::to_vec(&json!({
                "committed":committed,"transaction":transaction,"history":history,
                "undo":{SOURCE:{"kind":"file","content":STANDARD.encode(&original)}}
            }))
            .unwrap(),
        )
        .unwrap();
        let mut engine = Engine::open_project(dir.path()).unwrap();
        let (_, session) = engine.login(&key, "recovered", 1000).unwrap();
        let recovered = engine
            .file_transaction(&session.id, "crash-progress")
            .unwrap();
        if committed {
            assert_eq!(recovered, receipt);
            ok(&command(
                &mut engine,
                &session.id,
                json!({"command":"revert","transactionId":"crash-progress"}),
            ));
            assert_eq!(read(dir.path(), SOURCE)["goals"][0]["config"]["count"], 1);
        } else {
            rejected(&recovered, "interrupted");
            assert_eq!(fs::read(dir.path().join(SOURCE)).unwrap(), original);
            assert_eq!(engine.history_stats(&session.id).unwrap().head, 1);
            rejected(
                &command(
                    &mut engine,
                    &session.id,
                    json!({"command":"revert","transactionId":"crash-progress"}),
                ),
                "invalid",
            );
        }
    }
}
