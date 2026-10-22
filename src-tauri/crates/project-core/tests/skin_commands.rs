use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use serde_json::{json, Value};
use skin_core::codec::{build_c, encode_disk_file, skin_id_of, DecodedSkin};
use std::{fs, path::Path};

const LIBRARY: &str = ".hanshu/skinmanager/library.json";

fn open(root: &Path) -> (Engine, String) {
    let mut engine = Engine::open_project(root).unwrap();
    let key = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, session) = engine.login(&key, "skin-command-test", 1000).unwrap();
    (engine, session.id)
}
fn change(e: &mut Engine, sid: &str, path: &str, op: &str, bytes: &[u8]) -> FileChange {
    let lease = e
        .acquire_files(sid, &[path.into()], false, 1000)
        .unwrap()
        .remove(0);
    let version = e
        .files_snapshot(sid)
        .unwrap()
        .entries
        .into_iter()
        .find(|f| f.path == path)
        .map(|f| f.version);
    FileChange {
        op: op.into(),
        path: path.into(),
        version,
        content: Some(STANDARD.encode(bytes)),
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    }
}
fn command(e: &mut Engine, sid: &str, value: Value) -> FileChange {
    change(
        e,
        sid,
        LIBRARY,
        "skin-library-command",
        &serde_json::to_vec(&value).unwrap(),
    )
}
fn commit(e: &mut Engine, sid: &str, changes: Vec<FileChange>) -> FileTransactionReceipt {
    e.commit_files(sid, &uuid::Uuid::new_v4().to_string(), changes, 1000)
        .unwrap()
}
fn run(e: &mut Engine, sid: &str, value: Value) -> FileTransactionReceipt {
    let c = command(e, sid, value);
    commit(e, sid, vec![c])
}
fn ok(receipt: &FileTransactionReceipt) {
    assert_eq!(
        receipt.status,
        FileTransactionStatus::Committed,
        "{receipt:?}"
    );
    assert!(receipt.skin_command_result.is_some());
}
fn reject(receipt: &FileTransactionReceipt, code: &str) {
    assert_eq!(
        receipt.status,
        FileTransactionStatus::Rejected,
        "{receipt:?}"
    );
    assert_eq!(receipt.error.as_ref().unwrap().code, code, "{receipt:?}");
    assert!(receipt.skin_command_result.is_none());
    assert!(receipt.skin_entries.is_none());
}
fn library(root: &Path) -> Value {
    serde_json::from_slice(&fs::read(root.join(LIBRARY)).unwrap()).unwrap()
}
fn object() -> (String, Vec<u8>) {
    let decoded = DecodedSkin {
        rgba: vec![0; 64 * 64 * 4],
        width: 64,
        height: 64,
        flags: 0,
    };
    (
        skin_id_of(&build_c(0, 64, 64, &decoded.rgba).unwrap()),
        encode_disk_file(&decoded).unwrap(),
    )
}
fn entry(id: &str) -> Value {
    json!({"entryId":id,"skinId":object().0,"name":id,"active":true,"tags":[],"folderId":null,
        "favorite":false,"model":"classic","textureWidth":64,"textureHeight":64,
        "source":{"kind":"png-file","fileName":"skin.png"},
        "provenance":{"author":null,"sourceName":null,"sourceUrl":null,"sourceNote":null,"originalCreatedAt":null},
        "license":{"status":"unspecified","name":null,"url":null,"note":null},
        "note":"","customId":null,"createdAt":"client time","updatedAt":"client time","revision":999})
}
fn import_changes(e: &mut Engine, sid: &str, entry: Value) -> Vec<FileChange> {
    let (id, bytes) = object();
    vec![
        change(
            e,
            sid,
            &format!(".hanshu/skinmanager/objects/{}/{id}.skin", &id[..2]),
            "write",
            &bytes,
        ),
        command(e, sid, json!({"command":"import-entry","entry":entry})),
    ]
}
fn setup(root: &Path) -> (Engine, String) {
    let (mut e, sid) = open(root);
    ok(&run(&mut e, &sid, json!({"command":"ensure-library"})));
    for id in ["a", "b"] {
        let changes = import_changes(&mut e, &sid, entry(id));
        ok(&commit(&mut e, &sid, changes));
    }
    (e, sid)
}
fn refs(ids: &[(&str, u64)]) -> Value {
    json!(ids
        .iter()
        .map(|(id, revision)| json!({"entryId":id,"revision":revision}))
        .collect::<Vec<_>>())
}
fn folder(e: &mut Engine, sid: &str, id: &str, name: &str, parent: Option<&str>) -> Value {
    let receipt = run(
        e,
        sid,
        json!({"command":"create-folder","folderId":id,"name":name,"parentId":parent}),
    );
    ok(&receipt);
    receipt.skin_command_result.unwrap()["result"]["folder"].clone()
}

#[test]
fn ensure_is_idempotent_and_rejects_old_schema_without_rewriting() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = open(root.path());
    let first = run(&mut e, &sid, json!({"command":"ensure-library"}));
    ok(&first);
    assert_eq!(
        first.skin_command_result.unwrap()["result"]["created"],
        true
    );
    let before = fs::read(root.path().join(LIBRARY)).unwrap();
    let second = run(&mut e, &sid, json!({"command":"ensure-library"}));
    ok(&second);
    assert_eq!(
        second.skin_command_result.unwrap()["result"]["created"],
        false
    );
    assert_eq!(fs::read(root.path().join(LIBRARY)).unwrap(), before);
    fs::write(root.path().join(LIBRARY), b"{\"schemaVersion\":4}").unwrap();
    reject(
        &run(&mut e, &sid, json!({"command":"ensure-library"})),
        "storage",
    );
    assert_eq!(
        fs::read(root.path().join(LIBRARY)).unwrap(),
        b"{\"schemaVersion\":4}"
    );
}

#[test]
fn batch_commands_ignore_unrelated_index_changes_and_are_all_or_nothing() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    let stale = command(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("b",1)]),"changes":{"active":false}}),
    );
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("a",1)]),"changes":{"addTags":["A"]}}),
    ));
    ok(&commit(&mut e, &sid, vec![stale]));
    let before = library(root.path());
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"batch-patch","expectedEntries":refs(&[("b",2),("a",1)]),"changes":{"active":true}}),
        ),
        "conflict",
    );
    assert_eq!(library(root.path()), before);
    assert_eq!(before["entries"][0]["tags"], json!(["A"]));
    assert_eq!(before["entries"][1]["active"], false);
    assert_eq!(before["revision"], 5);
}

#[test]
fn import_sets_revision_time_and_reuses_identical_content_addressed_objects() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = open(root.path());
    ok(&run(&mut e, &sid, json!({"command":"ensure-library"})));
    let first = import_changes(&mut e, &sid, entry("a"));
    let second = import_changes(&mut e, &sid, entry("b"));
    assert!(second[0].version.is_none());
    ok(&commit(&mut e, &sid, first));
    ok(&commit(&mut e, &sid, second));
    let result = library(root.path());
    assert_eq!(result["entries"].as_array().unwrap().len(), 2);
    assert_eq!(result["entries"][0]["revision"], 1);
    assert_ne!(result["entries"][0]["createdAt"], "client time");
}

#[test]
fn invalid_import_object_or_metadata_rolls_back_object_and_index() {
    for failure in [
        "object",
        "dimensions",
        "customId",
        "model",
        "tags",
        "source",
        "license",
        "folder",
    ] {
        let root = tempfile::tempdir().unwrap();
        let (mut e, sid) = open(root.path());
        ok(&run(&mut e, &sid, json!({"command":"ensure-library"})));
        let mut candidate = entry("a");
        match failure {
            "dimensions" => candidate["textureHeight"] = json!(32),
            "customId" => candidate["customId"] = json!("x".repeat(65)),
            "model" => candidate["model"] = json!("unknown"),
            "tags" => candidate["tags"] = json!(false),
            "source" => candidate["source"] = json!({"kind":"png-url"}),
            "license" => candidate["license"]["status"] = json!("unknown"),
            "folder" => candidate["folderId"] = json!("gone"),
            _ => {}
        }
        let mut changes = import_changes(&mut e, &sid, candidate);
        if failure == "object" {
            changes[0].content = Some(STANDARD.encode("invalid skin"));
        }
        let object_path = changes[0].path.clone();
        reject(
            &commit(&mut e, &sid, changes),
            if failure == "folder" {
                "conflict"
            } else {
                "invalid"
            },
        );
        assert!(!root.path().join(object_path).exists(), "{failure}");
        assert_eq!(library(root.path())["entries"], json!([]));
    }
}

#[test]
fn import_requires_unique_entry_and_custom_ids_and_existing_object() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"import-entry","entry":entry("a")}),
        ),
        "conflict",
    );
    let mut c = entry("c");
    c["customId"] = json!("custom");
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"import-entry","entry":c}),
    ));
    let mut d = entry("d");
    d["customId"] = json!("custom");
    reject(
        &run(&mut e, &sid, json!({"command":"import-entry","entry":d})),
        "conflict",
    );
    let mut missing = entry("missing");
    missing["skinId"] = json!("a".repeat(64));
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"import-entry","entry":missing}),
        ),
        "conflict",
    );
    assert_eq!(library(root.path())["entries"].as_array().unwrap().len(), 3);
}

#[test]
fn folder_rename_move_sort_validate_snapshot_uniqueness_and_cycles() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    let parent = folder(&mut e, &sid, "p", "Parent", None);
    let child = folder(&mut e, &sid, "c", "Child", Some("p"));
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"patch-folder","expectedFolder":parent,"changes":{"parentId":"c"}}),
        ),
        "invalid",
    );
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"patch-folder","expectedFolder":child,"changes":{"parentId":"missing"}}),
        ),
        "conflict",
    );
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"create-folder","folderId":"duplicate","name":"Parent","parentId":null}),
        ),
        "conflict",
    );
    let a = folder(&mut e, &sid, "a", "A", None);
    let before = library(root.path())["folders"].clone();
    let renamed = run(
        &mut e,
        &sid,
        json!({"command":"patch-folder","expectedFolder":parent,"changes":{"name":"Z"}}),
    );
    ok(&renamed);
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"patch-folder","expectedFolder":a,"changes":{"sortSiblingsByName":true},"expectedSiblings":before.as_array().unwrap().iter().filter(|f| f["parentId"].is_null()).collect::<Vec<_>>() }),
        ),
        "conflict",
    );
    let current = library(root.path())["folders"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["parentId"].is_null())
        .cloned()
        .collect::<Vec<_>>();
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"patch-folder","expectedFolder":a,"changes":{"sortSiblingsByName":true},"expectedSiblings":current}),
    ));
    let values = library(root.path())["folders"].as_array().unwrap().clone();
    assert_eq!(
        values.iter().find(|f| f["folderId"] == "a").unwrap()["sortOrder"],
        0
    );
    assert_eq!(
        values.iter().find(|f| f["folderId"] == "p").unwrap()["sortOrder"],
        1
    );
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"patch-folder","expectedFolder":parent,"changes":{"name":"stale"}}),
        ),
        "conflict",
    );
}

#[test]
fn delete_folder_is_empty_only_and_does_not_move_entries_or_children() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    let parent = folder(&mut e, &sid, "p", "Parent", None);
    let child = folder(&mut e, &sid, "c", "Child", Some("p"));
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"delete-folder","expectedFolder":parent}),
        ),
        "conflict",
    );
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("a",1)]),"changes":{"folderId":"c"}}),
    ));
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"delete-folder","expectedFolder":child}),
        ),
        "conflict",
    );
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("a",2)]),"changes":{"folderId":null}}),
    ));
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"delete-folder","expectedFolder":child}),
    ));
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"delete-folder","expectedFolder":parent}),
    ));
    assert_eq!(library(root.path())["folders"], json!([]));
}

#[test]
fn recursive_entry_delete_rejects_new_entries_and_changed_folder_closure() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    let p = folder(&mut e, &sid, "p", "Parent", None);
    let c = folder(&mut e, &sid, "c", "Child", Some("p"));
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("a",1)]),"changes":{"folderId":"c"}}),
    ));
    let stale = json!({"command":"delete-folder-entries","folderId":"p","expectedFolders":[p,c],"expectedEntries":refs(&[("a",2)])});
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("b",1)]),"changes":{"folderId":"p"}}),
    ));
    reject(&run(&mut e, &sid, stale), "conflict");
    let d = folder(&mut e, &sid, "d", "New", Some("p"));
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"delete-folder-entries","folderId":"p","expectedFolders":[p,c],"expectedEntries":refs(&[("a",2),("b",2)])}),
        ),
        "conflict",
    );
    let result = run(
        &mut e,
        &sid,
        json!({"command":"delete-folder-entries","folderId":"p","expectedFolders":[p,c,d],"expectedEntries":refs(&[("a",2),("b",2)])}),
    );
    ok(&result);
    assert_eq!(result.skin_command_result.unwrap()["result"]["deleted"], 2);
    assert_eq!(library(root.path())["folders"].as_array().unwrap().len(), 3);
    assert_eq!(library(root.path())["entries"], json!([]));
}

#[test]
fn tag_rename_and_delete_check_complete_matching_scope_and_normalize() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("a",1)]),"changes":{"addTags":["Old","New"]}}),
    ));
    let stale =
        json!({"command":"rename-tag","from":"old","to":"New","expectedEntries":refs(&[("a",2)])});
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("b",1)]),"changes":{"addTags":["OLD"]}}),
    ));
    reject(&run(&mut e, &sid, stale), "conflict");
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"rename-tag","from":"old","to":"New","expectedEntries":refs(&[("a",2),("b",2)])}),
    ));
    assert_eq!(library(root.path())["entries"][0]["tags"], json!(["New"]));
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"delete-tag","name":"New","expectedEntries":refs(&[("a",3)])}),
        ),
        "conflict",
    );
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"delete-tag","name":"New","expectedEntries":refs(&[("a",3),("b",3)])}),
    ));
    assert_eq!(library(root.path())["entries"][1]["tags"], json!([]));
}

#[test]
fn delete_entries_checks_all_revisions_and_preserves_unselected_changes() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("a",1)]),"changes":{"active":false}}),
    ));
    reject(
        &run(
            &mut e,
            &sid,
            json!({"command":"delete-entries","expectedEntries":refs(&[("b",1),("a",1)])}),
        ),
        "conflict",
    );
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"delete-entries","expectedEntries":refs(&[("b",1)])}),
    ));
    assert_eq!(library(root.path())["entries"].as_array().unwrap().len(), 1);
    assert_eq!(library(root.path())["entries"][0]["active"], false);
}

#[test]
fn immutable_command_receipt_replays_after_restart_without_reapplying_delete() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    let edit = command(
        &mut e,
        &sid,
        json!({"command":"delete-entries","expectedEntries":refs(&[("a",1)])}),
    );
    let receipt = e
        .commit_files(&sid, "delete-once", vec![edit.clone()], 1000)
        .unwrap();
    ok(&receipt);
    ok(&run(
        &mut e,
        &sid,
        json!({"command":"batch-patch","expectedEntries":refs(&[("b",1)]),"changes":{"active":false}}),
    ));
    let before = library(root.path());
    drop(e);
    let (mut e, sid) = open(root.path());
    let mut replay = edit;
    replay.lease_id = "expired".into();
    assert_eq!(
        e.commit_files(&sid, "delete-once", vec![replay], 1000)
            .unwrap(),
        receipt
    );
    assert_eq!(library(root.path()), before);
}

#[test]
fn invalid_commands_cannot_escape_path_or_mix_index_mutations_or_bypass_lease() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    for value in [
        json!({"command":"ensure-library","unknown":true}),
        json!({"command":"batch-patch","expectedEntries":refs(&[("a",1),("a",1)]),"changes":{"active":false}}),
        json!({"command":"batch-patch","expectedEntries":refs(&[("a",1)]),"changes":{"skinId":"x"}}),
    ] {
        reject(&run(&mut e, &sid, value), "invalid");
    }
    let mut edit = command(&mut e, &sid, json!({"command":"ensure-library"}));
    edit.lease_id = "forged".into();
    reject(&commit(&mut e, &sid, vec![edit]), "locked");
    let first = command(&mut e, &sid, json!({"command":"ensure-library"}));
    let second = command(
        &mut e,
        &sid,
        json!({"command":"delete-entries","expectedEntries":refs(&[("a",1)])}),
    );
    reject(&commit(&mut e, &sid, vec![first, second]), "invalid");
    let wrong = change(
        &mut e,
        &sid,
        "assets/other.json",
        "skin-library-command",
        br#"{"command":"ensure-library"}"#,
    );
    reject(&commit(&mut e, &sid, vec![wrong]), "invalid");
}

#[test]
fn garbage_collection_cannot_remove_retained_objects_but_can_collect_after_delete() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid) = setup(root.path());
    let id = object().0;
    let path = format!(".hanshu/skinmanager/objects/{}/{id}.skin", &id[..2]);
    let mut remove = change(&mut e, &sid, &path, "remove", b"");
    remove.content = None;
    reject(&commit(&mut e, &sid, vec![remove.clone()]), "conflict");
    let delete = command(
        &mut e,
        &sid,
        json!({"command":"delete-entries","expectedEntries":refs(&[("a",1),("b",1)])}),
    );
    ok(&commit(&mut e, &sid, vec![delete, remove]));
    assert!(!root.path().join(path).exists());
}
