use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

fn open(root: &Path) -> (Engine, String) {
    let mut engine = Engine::open_project(root).unwrap();
    let key = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, session) = engine.login(&key, "restore-test", 1000).unwrap();
    (engine, session.id)
}
fn selection(sequence: u64, paths: Option<Vec<&str>>) -> HistoryRestoreSelection {
    HistoryRestoreSelection {
        sequence,
        paths: paths.map(|paths| paths.into_iter().map(str::to_owned).collect()),
        skin_entry_id: None,
        include_related: true,
    }
}
fn command(plan: &HistoryRestorePlan) -> FileChange {
    FileChange {
        op: "history-restore".into(),
        path: "project.json".into(),
        version: None,
        content: Some(STANDARD.encode(serde_json::to_vec(&plan.request).unwrap())),
        destination: None,
        destination_version: None,
        lease_id: String::new(),
    }
}
fn decode(path: &Path) -> Value {
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(fs::File::open(path).unwrap())
        .read_to_end(&mut bytes)
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[test]
fn editor_cannot_disguise_whole_project_restore_as_explicit_roots_but_one_owned_resource_is_allowed(
) {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("src/hanshu")).unwrap();
    fs::create_dir_all(dir.path().join("assets/zh_cn/lang_hs")).unwrap();
    fs::write(dir.path().join("src/hanshu/a.hs"), "before").unwrap();
    fs::write(
        dir.path().join("assets/zh_cn/lang_hs/a.lang"),
        "before language",
    )
    .unwrap();
    let (mut e, owner) = open(dir.path());
    let (_, key) = e
        .create_subject(&owner, "Editor".into(), "account".into(), Role::Editor)
        .unwrap();
    let (_, editor) = e.login(&key, "editor", 1000).unwrap();
    fs::write(dir.path().join("src/hanshu/a.hs"), "after").unwrap();
    fs::write(
        dir.path().join("assets/zh_cn/lang_hs/a.lang"),
        "after language",
    )
    .unwrap();
    for paths in [
        None,
        Some(vec!["src", "assets"]),
        Some(vec![
            "project.json",
            "src",
            "meta",
            "assets",
            ".hanshu/skinmanager",
        ]),
    ] {
        assert_eq!(
            e.plan_history_restore(&editor.id, selection(1, paths.clone()))
                .unwrap_err()
                .code,
            "forbidden"
        );
        let privileged = e.plan_history_restore(&owner, selection(1, paths)).unwrap();
        let receipt = e
            .commit_files(
                &editor.id,
                &uuid::Uuid::new_v4().to_string(),
                vec![command(&privileged)],
                1000,
            )
            .unwrap();
        assert_eq!(receipt.status, FileTransactionStatus::Rejected);
        assert_eq!(receipt.error.unwrap().code, "forbidden");
    }
    let plan = e
        .plan_history_restore(&editor.id, selection(1, Some(vec!["src/hanshu/a.hs"])))
        .unwrap();
    assert_eq!(plan.changes.len(), 2);
    assert_eq!(
        e.commit_files(&editor.id, "one-resource", vec![command(&plan)], 1000)
            .unwrap()
            .status,
        FileTransactionStatus::Committed
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("assets/zh_cn/lang_hs/a.lang")).unwrap(),
        "before language"
    );
}

#[test]
fn server_history_can_replace_file_and_directory_types_without_opening_raw_client_batches() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("assets")).unwrap();
    fs::write(dir.path().join("assets/node"), "flat").unwrap();
    let (mut e, sid) = open(dir.path());
    fs::remove_file(dir.path().join("assets/node")).unwrap();
    fs::create_dir_all(dir.path().join("assets/node/empty")).unwrap();
    fs::write(dir.path().join("assets/node/binary.bin"), [0, 255, 7]).unwrap();
    assert_eq!(e.history_list(&sid, None, 20, None).unwrap().head, 2);
    let plan = e
        .plan_history_restore(&sid, selection(1, Some(vec!["assets/node"])))
        .unwrap();
    let receipt = e
        .commit_files(&sid, "to-file", vec![command(&plan)], 1000)
        .unwrap();
    assert_eq!(
        receipt.status,
        FileTransactionStatus::Committed,
        "{:?}",
        receipt.error
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("assets/node")).unwrap(),
        "flat"
    );
    let own = e
        .acquire_files(&sid, &["meta/kept.md".into()], false, 1000)
        .unwrap()
        .remove(0);
    let plan = e
        .plan_history_restore(&sid, selection(2, Some(vec!["assets/node"])))
        .unwrap();
    let receipt = e
        .commit_files(&sid, "to-directory", vec![command(&plan)], 1000)
        .unwrap();
    assert_eq!(
        receipt.status,
        FileTransactionStatus::Committed,
        "{:?}",
        receipt.error
    );
    assert_eq!(
        fs::read(dir.path().join("assets/node/binary.bin")).unwrap(),
        [0, 255, 7]
    );
    assert!(dir.path().join("assets/node/empty").is_dir());
    let leases = e.snapshot(&sid).unwrap().leases;
    assert_eq!(leases.len(), 1);
    assert_eq!(leases[0].id, own.id);
    let requests = [
        FileOperationRequest {
            op: FileOperationKind::Remove,
            path: "assets/node".into(),
            destination: None,
        },
        FileOperationRequest {
            op: FileOperationKind::Write,
            path: "assets/node".into(),
            destination: None,
        },
    ];
    assert_eq!(
        e.plan_file_operations(&sid, &requests).unwrap_err().code,
        "invalid"
    );
    let lease = e
        .acquire_files(&sid, &["assets/node".into()], false, 1000)
        .unwrap()
        .remove(0);
    let version = e
        .files_snapshot(&sid)
        .unwrap()
        .entries
        .into_iter()
        .find(|entry| entry.path == "assets/node")
        .unwrap()
        .version;
    let mut remove = FileChange {
        op: "remove".into(),
        path: "assets/node".into(),
        version: Some(version),
        content: None,
        destination: None,
        destination_version: None,
        lease_id: lease.id,
    };
    let mut write = remove.clone();
    write.op = "write".into();
    write.content = Some(STANDARD.encode("raw bypass"));
    let receipt = e
        .commit_files(
            &sid,
            "raw-bypass",
            vec![remove.clone(), write.clone()],
            1000,
        )
        .unwrap();
    assert_eq!(receipt.status, FileTransactionStatus::Rejected);
    assert_eq!(receipt.error.unwrap().code, "invalid");
    remove.op = "remove".into();
    let reverse = e
        .commit_files(&sid, "raw-reverse", vec![write, remove], 1000)
        .unwrap();
    assert_eq!(reverse.status, FileTransactionStatus::Rejected);
    assert_eq!(
        fs::read(dir.path().join("assets/node/binary.bin")).unwrap(),
        [0, 255, 7]
    );
}

#[test]
fn prepared_type_conversion_rolls_back_files_directories_and_binary_content_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("assets/node/empty")).unwrap();
    fs::write(dir.path().join("assets/node/binary.bin"), [0, 255, 7]).unwrap();
    let (mut e, sid) = open(dir.path());
    fs::remove_file(dir.path().join("assets/node/binary.bin")).unwrap();
    fs::remove_dir(dir.path().join("assets/node/empty")).unwrap();
    fs::remove_dir(dir.path().join("assets/node")).unwrap();
    fs::write(dir.path().join("assets/node"), "flat").unwrap();
    e.history_list(&sid, None, 20, None).unwrap();
    let plan = e
        .plan_history_restore(&sid, selection(1, Some(vec!["assets/node"])))
        .unwrap();
    let receipt = e
        .commit_files(&sid, "interrupted-conversion", vec![command(&plan)], 1000)
        .unwrap();
    assert_eq!(receipt.status, FileTransactionStatus::Committed);
    let archive = fs::read_dir(dir.path().join(".hanshu/service/file-transactions/archive"))
        .unwrap()
        .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
        .map(|entry| entry.unwrap().path())
        .next()
        .unwrap();
    let record = decode(&archive);
    let history_path = dir
        .path()
        .join(".hanshu/service/history/revisions/00000000000000000003.json.gz");
    let history = decode(&history_path);
    drop(e);
    fs::remove_file(archive).unwrap();
    fs::remove_file(history_path).unwrap();
    fs::write(
        dir.path().join(".hanshu/service/file-undo.json"),
        serde_json::to_vec(&json!({
            "committed":false,"transaction":record,"history":history,
            "undo":{"assets/node":{"kind":"file","content":STANDARD.encode("flat")},
                "assets/node/empty":{"kind":"missing","content":null},
                "assets/node/binary.bin":{"kind":"missing","content":null}}
        }))
        .unwrap(),
    )
    .unwrap();
    let (e, sid) = open(dir.path());
    assert_eq!(
        fs::read_to_string(dir.path().join("assets/node")).unwrap(),
        "flat"
    );
    assert_eq!(
        e.file_transaction(&sid, "interrupted-conversion")
            .unwrap()
            .status,
        FileTransactionStatus::Rejected
    );
    assert_eq!(e.history_list(&sid, None, 20, None).unwrap().head, 2);
}
