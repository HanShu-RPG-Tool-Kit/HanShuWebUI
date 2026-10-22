use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use serde_json::{json, Value};
use std::{fs, path::Path};

const LIBRARY: &str = ".hanshu/skinmanager/library.json";

fn entry(id: &str, skin: &str) -> Value {
    json!({
        "entryId":id,"skinId":skin,"name":id,"active":true,"tags":[],"folderId":null,
        "favorite":false,"model":"classic","textureWidth":64,"textureHeight":64,
        "source":{"kind":"png-file","fileName":"skin.png"},
        "provenance":{"author":null,"sourceName":null,"sourceUrl":null,"sourceNote":null,"originalCreatedAt":null},
        "license":{"status":"unspecified","name":null,"url":null,"note":null},
        "note":"","customId":null,"createdAt":"2026-01-01T00:00:00.000Z",
        "updatedAt":"2026-01-01T00:00:00.000Z","revision":1
    })
}

fn open(root: &Path) -> (Engine, String, String) {
    let mut e = Engine::open_project(root).unwrap();
    let key = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, s) = e.login(&key, "skin-patch-test", 1000).unwrap();
    (e, s.id, key)
}

fn setup(root: &Path) -> (Engine, String, String) {
    fs::create_dir_all(root.join(".hanshu/skinmanager")).unwrap();
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    fs::write(root.join(LIBRARY), serde_json::to_vec(&json!({
        "schemaVersion":5,"revision":1,"folders":[{"folderId":"folder","name":"Folder","parentId":null,"sortOrder":0}],
        "entries":[entry("a", &a),entry("b", &b)]
    })).unwrap()).unwrap();
    for id in [&a, &b] {
        let object = root.join(format!(
            ".hanshu/skinmanager/objects/{}/{id}.skin",
            &id[..2]
        ));
        fs::create_dir_all(object.parent().unwrap()).unwrap();
        fs::write(object, "immutable object bytes").unwrap();
    }
    open(root)
}

fn library(root: &Path) -> Value {
    serde_json::from_slice(&fs::read(root.join(LIBRARY)).unwrap()).unwrap()
}

fn version(e: &Engine, sid: &str, path: &str) -> Option<String> {
    e.files_snapshot(sid)
        .unwrap()
        .entries
        .into_iter()
        .find(|f| f.path == path)
        .map(|f| f.version)
}

fn change(e: &mut Engine, sid: &str, id: &str, revision: u64, changes: Value) -> FileChange {
    let lease = e
        .acquire_files(sid, &[LIBRARY.into()], false, 1000)
        .unwrap()
        .remove(0);
    FileChange {
        op: "skin-entry-patch".into(),
        path: LIBRARY.into(),
        version: version(e, sid, LIBRARY),
        content: Some(
            STANDARD.encode(
                serde_json::to_vec(
                    &json!({"entryId":id,"expectedRevision":revision,"changes":changes}),
                )
                .unwrap(),
            ),
        ),
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    }
}

fn commit(e: &mut Engine, sid: &str, edits: Vec<FileChange>) -> FileTransactionReceipt {
    e.commit_files(sid, &uuid::Uuid::new_v4().to_string(), edits, 1000)
        .unwrap()
}

fn rejected(receipt: &FileTransactionReceipt, code: &str) {
    assert_eq!(
        receipt.status,
        FileTransactionStatus::Rejected,
        "{receipt:?}"
    );
    assert_eq!(receipt.error.as_ref().unwrap().code, code);
    assert!(receipt.tree.is_none());
    assert!(receipt.skin_entries.is_none());
}

#[test]
fn independent_entries_accept_old_index_versions_but_same_entry_conflicts() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, key) = setup(root.path());
    let old = version(&e, &sid, LIBRARY);
    let first = change(&mut e, &sid, "a", 1, json!({"name":"Alpha"}));
    let first_result = commit(&mut e, &sid, vec![first.clone()]);
    assert_eq!(first_result.status, FileTransactionStatus::Committed);
    e.release(&sid, &format!("file:{LIBRARY}"), &first.lease_id, 1000)
        .unwrap();
    let (_, other) = e.login(&key, "other client", 1000).unwrap();
    let mut second = change(&mut e, &other.id, "b", 1, json!({"name":"Beta"}));
    second.version = old.clone();
    assert_eq!(
        commit(&mut e, &other.id, vec![second]).status,
        FileTransactionStatus::Committed
    );
    let mut stale = change(&mut e, &other.id, "a", 1, json!({"name":"Old Alpha"}));
    stale.version = old;
    rejected(&commit(&mut e, &other.id, vec![stale]), "conflict");
    let result = library(root.path());
    assert_eq!(result["entries"][0]["name"], "Alpha");
    assert_eq!(result["entries"][1]["name"], "Beta");
    assert_eq!(result["revision"], 3);
    assert_eq!(result["entries"][0]["revision"], 2);
    assert_eq!(result["entries"][1]["revision"], 2);
}

#[test]
fn ordinary_index_replacement_still_uses_file_cas_after_semantic_patch() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let original = fs::read(root.path().join(LIBRARY)).unwrap();
    let mut edit = change(&mut e, &sid, "a", 1, json!({"name":"new"}));
    assert_eq!(
        commit(&mut e, &sid, vec![edit.clone()]).status,
        FileTransactionStatus::Committed
    );
    edit.op = "write".into();
    edit.content = Some(STANDARD.encode(original));
    rejected(&commit(&mut e, &sid, vec![edit]), "conflict");
    assert_eq!(library(root.path())["entries"][0]["name"], "new");
}

#[test]
fn semantic_receipt_replays_exact_entry_after_later_updates_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let edit = change(&mut e, &sid, "a", 1, json!({"name":"first"}));
    let receipt = e
        .commit_files(&sid, "skin-save", vec![edit.clone()], 1000)
        .unwrap();
    assert_eq!(receipt.skin_entries.as_ref().unwrap()[0]["name"], "first");
    let later = change(&mut e, &sid, "a", 2, json!({"name":"later"}));
    assert_eq!(
        commit(&mut e, &sid, vec![later]).status,
        FileTransactionStatus::Committed
    );
    assert_eq!(e.file_transaction(&sid, "skin-save").unwrap(), receipt);
    drop(e);
    let (mut e, sid, _) = open(root.path());
    let mut replay = edit.clone();
    replay.lease_id = "expired".into();
    assert_eq!(
        e.commit_files(&sid, "skin-save", vec![replay], 1000)
            .unwrap(),
        receipt
    );
    assert_eq!(library(root.path())["entries"][0]["name"], "later");
    let mut changed_payload = edit;
    changed_payload.content = Some(STANDARD.encode(b"{}"));
    assert_eq!(
        e.commit_files(&sid, "skin-save", vec![changed_payload], 1000)
            .unwrap_err()
            .code,
        "conflict"
    );
}

#[test]
fn failed_other_change_rolls_back_semantic_entry_and_has_no_result_payload() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let before = fs::read(root.path().join(LIBRARY)).unwrap();
    let patch = change(&mut e, &sid, "a", 1, json!({"favorite":true}));
    let lease = e
        .acquire_files(&sid, &["assets/a.txt".into()], false, 1000)
        .unwrap()
        .remove(0);
    let write = FileChange {
        op: "write".into(),
        path: "assets/a.txt".into(),
        version: Some("stale".into()),
        content: Some(STANDARD.encode("new")),
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    };
    rejected(&commit(&mut e, &sid, vec![patch, write]), "conflict");
    assert_eq!(fs::read(root.path().join(LIBRARY)).unwrap(), before);
    assert!(!root.path().join("assets/a.txt").exists());
}

#[test]
fn patch_requires_writer_role_and_exact_unexpired_lease() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let edit = change(&mut e, &sid, "a", 1, json!({"favorite":true}));
    let (_, viewer_key) = e
        .create_subject(&sid, "Viewer".into(), "agent".into(), Role::Viewer)
        .unwrap();
    let (_, viewer) = e.login(&viewer_key, "viewer", 1000).unwrap();
    rejected(&commit(&mut e, &viewer.id, vec![edit.clone()]), "forbidden");
    let mut forged = edit.clone();
    forged.lease_id = "not-the-lease".into();
    rejected(&commit(&mut e, &sid, vec![forged]), "locked");
    e.release(&sid, &format!("file:{LIBRARY}"), &edit.lease_id, 1000)
        .unwrap();
    rejected(&commit(&mut e, &sid, vec![edit]), "locked");
}

#[test]
fn unknown_fields_wrong_types_empty_changes_and_wrong_paths_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let before = fs::read(root.path().join(LIBRARY)).unwrap();
    for changes in [
        json!({}),
        json!({"skinId":"different"}),
        json!({"revision":99}),
        json!({"name":null}),
        json!({"name":"  "}),
        json!({"active":1}),
        json!({"model":"steve"}),
        json!({"tags":[1]}),
        json!({"license":{"status":"unknown"}}),
        json!({"license":{"status":"declared","script":"bad"}}),
        json!({"provenance":{"unknown":true}}),
    ] {
        let edit = change(&mut e, &sid, "a", 1, changes);
        rejected(&commit(&mut e, &sid, vec![edit]), "invalid");
    }
    let mut edit = change(&mut e, &sid, "a", 1, json!({"name":"allowed"}));
    edit.content =
        Some(STANDARD.encode(
            br#"{"entryId":"a","expectedRevision":1,"changes":{"name":"x"},"unknown":true}"#,
        ));
    rejected(&commit(&mut e, &sid, vec![edit.clone()]), "invalid");
    edit.path = "assets/not-library.json".into();
    rejected(&commit(&mut e, &sid, vec![edit]), "invalid");
    assert_eq!(fs::read(root.path().join(LIBRARY)).unwrap(), before);
}

#[test]
fn custom_id_folder_and_tag_changes_validate_against_latest_library() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let edit = change(
        &mut e,
        &sid,
        "a",
        1,
        json!({"customId":" hero ","folderId":"folder",
        "tags":[" X ","x","Y"],"addTags":["z"],"removeTags":["y"],"model":"slim",
        "license":{"status":"declared","name":"MIT"},"provenance":{"author":"Alice"}}),
    );
    let receipt = commit(&mut e, &sid, vec![edit]);
    assert_eq!(receipt.status, FileTransactionStatus::Committed);
    let entry = &receipt.skin_entries.unwrap()[0];
    assert_eq!(entry["customId"], "hero");
    assert_eq!(entry["tags"], json!(["X", "z"]));
    assert_eq!(entry["folderId"], "folder");
    assert_eq!(entry["model"], "slim");
    assert_eq!(entry["license"]["url"], Value::Null);
    assert_eq!(entry["provenance"]["sourceName"], Value::Null);
    for changes in [json!({"customId":"hero"}), json!({"folderId":"missing"})] {
        let edit = change(&mut e, &sid, "b", 1, changes);
        rejected(&commit(&mut e, &sid, vec![edit]), "conflict");
    }
    let clear = change(
        &mut e,
        &sid,
        "a",
        2,
        json!({"customId":null,"folderId":null}),
    );
    assert_eq!(
        commit(&mut e, &sid, vec![clear]).status,
        FileTransactionStatus::Committed
    );
    assert_eq!(library(root.path())["entries"][0]["customId"], Value::Null);
}

#[test]
fn patch_cannot_mix_index_replacement_or_delete_referenced_object() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let patch = change(&mut e, &sid, "a", 1, json!({"name":"new"}));
    let mut replacement = patch.clone();
    replacement.op = "write".into();
    replacement.content = Some(STANDARD.encode(fs::read(root.path().join(LIBRARY)).unwrap()));
    rejected(
        &commit(&mut e, &sid, vec![patch.clone(), replacement]),
        "invalid",
    );
    rejected(
        &commit(&mut e, &sid, vec![patch.clone(), patch.clone()]),
        "invalid",
    );
    let id = "a".repeat(64);
    let path = format!(".hanshu/skinmanager/objects/aa/{id}.skin");
    let lease = e
        .acquire_files(&sid, &[path.clone()], false, 1000)
        .unwrap()
        .remove(0);
    let remove = FileChange {
        op: "remove".into(),
        version: version(&e, &sid, &path),
        path: path.clone(),
        content: None,
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    };
    rejected(&commit(&mut e, &sid, vec![patch, remove]), "conflict");
    assert!(root.path().join(path).exists());
    assert_eq!(library(root.path())["entries"][0]["name"], "a");
}

#[test]
fn operation_plan_exposes_exact_index_authority_and_no_related_resource_locks() {
    let root = tempfile::tempdir().unwrap();
    let (e, sid, _) = setup(root.path());
    let plan = e
        .plan_file_operations(
            &sid,
            &[FileOperationRequest {
                op: FileOperationKind::SkinEntryPatch,
                path: LIBRARY.into(),
                destination: None,
            }],
        )
        .unwrap();
    assert_eq!(plan.operations.len(), 1);
    assert_eq!(plan.operations[0].op, FileOperationKind::SkinEntryPatch);
    assert_eq!(plan.lease_paths, vec![LIBRARY]);
    assert_eq!(plan.authorities[0].authority_path, LIBRARY);
    assert!(plan.relations.is_empty());
}

fn replace_library(e: &mut Engine, sid: &str, value: &Value) -> FileChange {
    let mut edit = change(e, sid, "unused", 1, json!({"name":"unused"}));
    edit.op = "write".into();
    edit.content = Some(STANDARD.encode(serde_json::to_vec(value).unwrap()));
    edit
}

#[test]
fn whole_index_edits_must_advance_changed_entries_without_rewriting_candidate_bytes() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let original = library(root.path());
    for field in ["name", "updatedAt", "folderId"] {
        let mut candidate = original.clone();
        candidate["entries"][0][field] = json!("changed");
        let edit = replace_library(&mut e, &sid, &candidate);
        rejected(&commit(&mut e, &sid, vec![edit]), "invalid");
        assert_eq!(library(root.path()), original);
    }
    let mut candidate = original.clone();
    candidate["entries"][0]["name"] = json!("changed");
    candidate["entries"][0]["revision"] = json!(2);
    let edit = replace_library(&mut e, &sid, &candidate);
    let bytes = STANDARD.decode(edit.content.as_ref().unwrap()).unwrap();
    assert_eq!(
        commit(&mut e, &sid, vec![edit]).status,
        FileTransactionStatus::Committed
    );
    assert_eq!(fs::read(root.path().join(LIBRARY)).unwrap(), bytes);
    // An old semantic draft must now fail even though the update came from a whole-index operation.
    let stale = change(&mut e, &sid, "a", 1, json!({"name":"old draft"}));
    rejected(&commit(&mut e, &sid, vec![stale]), "conflict");
    // Unchanged entries keep their original revisions, but may never move backwards.
    let same = replace_library(&mut e, &sid, &candidate);
    assert_eq!(
        commit(&mut e, &sid, vec![same]).status,
        FileTransactionStatus::Committed
    );
    candidate["entries"][0]["revision"] = json!(1);
    let rollback = replace_library(&mut e, &sid, &candidate);
    rejected(&commit(&mut e, &sid, vec![rollback]), "invalid");
    candidate["entries"][0]["revision"] = json!(3);
    let increase = replace_library(&mut e, &sid, &candidate);
    assert_eq!(
        commit(&mut e, &sid, vec![increase]).status,
        FileTransactionStatus::Committed
    );
}

#[test]
fn whole_index_revision_validation_is_atomic_and_rejects_malformed_entries() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let original = library(root.path());
    for invalid in [
        Value::Null,
        json!("bad"),
        json!({"entryId":"a","revision":"2"}),
        json!({"entryId":"a","revision":0}),
        json!({"entryId":null,"revision":2}),
    ] {
        let mut candidate = original.clone();
        candidate["entries"][0] = invalid;
        let edit = replace_library(&mut e, &sid, &candidate);
        rejected(&commit(&mut e, &sid, vec![edit]), "invalid");
    }
    let mut candidate = original.clone();
    candidate["entries"][1] = candidate["entries"][0].clone();
    let duplicate = replace_library(&mut e, &sid, &candidate);
    rejected(&commit(&mut e, &sid, vec![duplicate]), "invalid");
    candidate = original.clone();
    candidate["entries"][0]["name"] = json!("forgot revision increment");
    let invalid = replace_library(&mut e, &sid, &candidate);
    let path = "assets/atomic.txt";
    let lease = e
        .acquire_files(&sid, &[path.into()], false, 1000)
        .unwrap()
        .remove(0);
    let other = FileChange {
        op: "write".into(),
        path: path.into(),
        version: None,
        content: Some(STANDARD.encode("not published")),
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    };
    rejected(&commit(&mut e, &sid, vec![other, invalid]), "invalid");
    assert!(!root.path().join(path).exists());
    assert_eq!(library(root.path()), original);
}

#[test]
fn whole_index_revision_validation_allows_legacy_migration_creation_and_deletion() {
    let root = tempfile::tempdir().unwrap();
    let (mut e, sid, _) = setup(root.path());
    let mut legacy = library(root.path());
    legacy["schemaVersion"] = json!(4);
    legacy["entries"][0]["revision"] = json!(99);
    fs::write(
        root.path().join(LIBRARY),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let mut migrated = legacy;
    migrated["schemaVersion"] = json!(5);
    migrated["entries"][0]["revision"] = json!(1);
    let edit = replace_library(&mut e, &sid, &migrated);
    assert_eq!(
        commit(&mut e, &sid, vec![edit]).status,
        FileTransactionStatus::Committed
    );
    migrated["entries"].as_array_mut().unwrap().remove(0);
    migrated["entries"]
        .as_array_mut()
        .unwrap()
        .push(entry("new", &"a".repeat(64)));
    let edit = replace_library(&mut e, &sid, &migrated);
    assert_eq!(
        commit(&mut e, &sid, vec![edit]).status,
        FileTransactionStatus::Committed
    );
    assert_eq!(library(root.path()), migrated);
}
