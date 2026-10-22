use base64::{engine::general_purpose::STANDARD, Engine as _};
use project_core::*;
use std::{fs, path::Path};

fn setup(root: &Path, files: &[(&str, &str)]) -> (project_core::Engine, String) {
    for (path, content) in files {
        let target = root.join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }
    let mut engine = project_core::Engine::open_project(root).unwrap();
    let key = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, session) = engine.login(&key, "policy-test", 1000).unwrap();
    (engine, session.id)
}

fn request(op: FileOperationKind, path: &str, destination: Option<&str>) -> FileOperationRequest {
    FileOperationRequest {
        op,
        path: path.into(),
        destination: destination.map(str::to_owned),
    }
}

fn changes(
    engine: &mut project_core::Engine,
    sid: &str,
    plan: &ResourceOperationPlan,
) -> Vec<FileChange> {
    let leases = engine
        .acquire_files(sid, &plan.lease_paths, false, 1001)
        .unwrap();
    plan.operations
        .iter()
        .map(|operation| FileChange {
            op: match operation.op {
                FileOperationKind::ProgressCommand => "progress-command",
                FileOperationKind::HistoryRestore => "history-restore",
                FileOperationKind::Write => "write",
                FileOperationKind::SkinEntryPatch => "skin-entry-patch",
                FileOperationKind::SkinLibraryCommand => "skin-library-command",
                FileOperationKind::Mkdir => "mkdir",
                FileOperationKind::Check => "check",
                FileOperationKind::Move => "move",
                FileOperationKind::Remove => "remove",
            }
            .into(),
            path: operation.path.clone(),
            destination: operation.destination.clone(),
            version: operation.version.clone(),
            destination_version: operation.destination_version.clone(),
            content: (operation.op == FileOperationKind::Write)
                .then(|| STANDARD.encode("new content")),
            lease_id: leases
                .iter()
                .find(|lease| lease.resource_id == format!("file:{}", operation.path))
                .unwrap()
                .id
                .clone(),
        })
        .collect()
}

fn commit(
    engine: &mut project_core::Engine,
    sid: &str,
    changes: Vec<FileChange>,
) -> FileTransactionReceipt {
    engine
        .commit_files(sid, &uuid::Uuid::new_v4().to_string(), changes, 1002)
        .unwrap()
}

#[test]
fn relations_are_facts_and_reference_targets_are_never_leased_or_cascaded() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, sid) = setup(
        dir.path(),
        &[
            (
                "src/progress/a.progress",
                r#"{"rewardKits":["shared","missing.kit"]}"#,
            ),
            ("src/gift/shared.kit", "shared"),
            ("assets/zh_cn/lang_progress/a.lang", "title=A"),
        ],
    );
    let facts = engine
        .resource_relations(&sid, "src/progress/a.progress")
        .unwrap();
    assert_eq!(facts.relations.len(), 3);
    assert!(facts
        .relations
        .iter()
        .any(|relation| relation.kind == ResourceRelationKind::Reference
            && relation.to == "src/gift/missing.kit"));
    for operation in [FileOperationKind::Write, FileOperationKind::Remove] {
        let plan = engine
            .plan_file_operations(&sid, &[request(operation, "src/progress/a.progress", None)])
            .unwrap();
        assert!(plan
            .lease_paths
            .iter()
            .all(|path| !path.starts_with("src/gift/")));
        assert!(plan
            .operations
            .iter()
            .all(|operation| !operation.path.starts_with("src/gift/")));
    }
    let incoming = engine
        .resource_relations(&sid, "src/gift/shared.kit")
        .unwrap();
    assert_eq!(incoming.relations.len(), 1);
    assert_eq!(incoming.relations[0].from, "src/progress/a.progress");
}

#[test]
fn raw_path_leases_do_not_expand_but_commit_enforces_operation_policy() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(dir.path(), &[("src/hanshu/a.hs", "source")]);
    let path = "assets/zh_cn/lang_hs/a.lang";
    let leases = engine
        .acquire_files(&sid, &[path.into()], false, 1000)
        .unwrap();
    assert_eq!(leases.len(), 1);
    let change = FileChange {
        op: "write".into(),
        path: path.into(),
        version: None,
        content: Some(STANDARD.encode("title=A")),
        destination: None,
        destination_version: None,
        lease_id: leases[0].id.clone(),
    };
    assert_eq!(
        commit(&mut engine, &sid, vec![change.clone()])
            .error
            .unwrap()
            .code,
        "locked"
    );
    assert!(!dir.path().join(path).exists());
    let plan = engine
        .plan_file_operations(&sid, &[request(FileOperationKind::Write, path, None)])
        .unwrap();
    assert_eq!(plan.lease_paths, vec![path, "src/hanshu/a.hs"]);
    engine
        .acquire_files(&sid, &plan.lease_paths, false, 1001)
        .unwrap();
    assert_eq!(
        commit(&mut engine, &sid, vec![change]).status,
        FileTransactionStatus::Committed
    );
}

#[test]
fn source_directory_move_expands_all_locales_and_nested_voice_once() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            ("src/hanshu/chapter/a.hs", "A"),
            ("src/hanshu/chapter/sub/b.hs", "B"),
            ("assets/zh_cn/lang_hs/chapter/a.lang", "title=A"),
            ("assets/en_us/lang_hs/chapter/sub/b.lang", "title=B"),
            (
                "assets/en_us/voice_hs/chapter/a/nested/deep/line.ogg",
                "audio",
            ),
            ("assets/zh_cn/voice_hs/chapter/sub/b/line.ogg", "audio B"),
        ],
    );
    let plan = engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Move,
                "src/hanshu/chapter",
                Some("src/hanshu/next"),
            )],
        )
        .unwrap();
    assert_eq!(plan.operations.len(), 5);
    assert!(plan
        .operations
        .iter()
        .all(|operation| operation.origin_path == "src/hanshu/chapter"));
    assert!(plan
        .lease_paths
        .iter()
        .all(|path| !path.ends_with("deep.hs") && !path.ends_with("nested.hs")));
    let changes = changes(&mut engine, &sid, &plan);
    let receipt = commit(&mut engine, &sid, changes);
    assert_eq!(
        receipt.status,
        FileTransactionStatus::Committed,
        "{:?}",
        receipt.error
    );
    assert!(!dir.path().join("src/hanshu/chapter").exists());
    assert_eq!(
        fs::read_to_string(
            dir.path()
                .join("assets/en_us/voice_hs/next/a/nested/deep/line.ogg")
        )
        .unwrap(),
        "audio"
    );
    assert!(dir
        .path()
        .join("assets/en_us/lang_hs/next/sub/b.lang")
        .exists());
}

#[test]
fn nested_voice_presence_and_mutations_use_the_actual_source_authority() {
    let dir = tempfile::tempdir().unwrap();
    let path = "assets/en_us/voice_hs/chapter/a/nested/deep/line.ogg";
    let (mut engine, sid) = setup(
        dir.path(),
        &[("src/hanshu/chapter/a.hs", "A"), (path, "audio")],
    );
    let plan = engine
        .plan_file_operations(&sid, &[request(FileOperationKind::Write, path, None)])
        .unwrap();
    assert_eq!(
        plan.authorities
            .iter()
            .find(|authority| authority.path == path)
            .unwrap()
            .authority_path,
        "src/hanshu/chapter/a.hs"
    );
    assert_eq!(plan.lease_paths.len(), 2);
    engine
        .set_file_presence(&sid, Some(path.into()), None, FileActivity::Viewing, 1001)
        .unwrap();
    assert_eq!(
        engine
            .snapshot(&sid)
            .unwrap()
            .session
            .file_presence
            .unwrap()
            .authority_id,
        "file:src/hanshu/chapter/a.hs"
    );
}

#[test]
fn a_new_source_can_be_planned_with_nested_audio_before_any_file_exists() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, sid) = setup(dir.path(), &[]);
    let source = "src/hanshu/chapter/new.hs";
    let audio = "assets/en_us/voice_hs/chapter/new/nested/line.ogg";
    let plan = engine
        .plan_file_operations(
            &sid,
            &[
                request(FileOperationKind::Write, source, None),
                request(FileOperationKind::Write, audio, None),
            ],
        )
        .unwrap();
    assert!(plan
        .operations
        .iter()
        .all(|operation| operation.version.is_none()));
    assert_eq!(
        plan.authorities
            .iter()
            .find(|authority| authority.path == audio)
            .unwrap()
            .authority_path,
        source
    );
    assert_eq!(plan.lease_paths.len(), 2);
    assert!(engine.snapshot(&sid).unwrap().leases.is_empty());
}

#[test]
fn new_owned_assets_after_plan_cannot_be_omitted_from_a_structural_commit() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(dir.path(), &[("src/hanshu/a.hs", "A")]);
    let plan = engine
        .plan_file_operations(
            &sid,
            &[request(FileOperationKind::Remove, "src/hanshu/a.hs", None)],
        )
        .unwrap();
    let changes = changes(&mut engine, &sid, &plan);
    fs::create_dir_all(dir.path().join("assets/zh_cn/lang_hs")).unwrap();
    fs::write(dir.path().join("assets/zh_cn/lang_hs/a.lang"), "late").unwrap();
    let receipt = commit(&mut engine, &sid, changes);
    assert_eq!(receipt.error.unwrap().code, "invalid");
    assert!(dir.path().join("src/hanshu/a.hs").exists());
    assert!(dir.path().join("assets/zh_cn/lang_hs/a.lang").exists());
}

#[test]
fn new_nested_audio_after_plan_is_protected_by_directory_version() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            ("src/hanshu/a.hs", "A"),
            ("assets/en_us/voice_hs/a/first.ogg", "first"),
        ],
    );
    let plan = engine
        .plan_file_operations(
            &sid,
            &[request(FileOperationKind::Remove, "src/hanshu/a.hs", None)],
        )
        .unwrap();
    let changes = changes(&mut engine, &sid, &plan);
    fs::write(dir.path().join("assets/en_us/voice_hs/a/late.ogg"), "late").unwrap();
    let receipt = commit(&mut engine, &sid, changes);
    assert_eq!(receipt.error.unwrap().code, "conflict");
    assert!(dir.path().join("src/hanshu/a.hs").exists());
    assert!(dir.path().join("assets/en_us/voice_hs/a/late.ogg").exists());
}

#[test]
fn directories_cannot_bypass_contained_resource_policy_and_empty_check_is_fenced() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            ("src/hanshu/a.hs", "A"),
            ("assets/zh_cn/lang_hs/a.lang", "title=A"),
        ],
    );
    for operation in [FileOperationKind::Remove, FileOperationKind::Check] {
        let plan = engine
            .plan_file_operations(&sid, &[request(operation, "assets/zh_cn", None)])
            .unwrap();
        assert!(plan.lease_paths.contains(&"src/hanshu/a.hs".into()));
    }
    let plan = engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Check,
                "assets/zh_cn/lang_hs/missing.lang",
                None,
            )],
        )
        .unwrap();
    assert!(plan.lease_paths.contains(&"src/hanshu/missing.hs".into()));
    let mut submitted = changes(&mut engine, &sid, &plan);
    submitted[0].lease_id = "wrong".into();
    assert_eq!(
        commit(&mut engine, &sid, submitted).error.unwrap().code,
        "locked"
    );
}

#[test]
fn read_only_queries_are_available_to_viewers_and_malformed_unrelated_sources_do_not_block_them() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            ("src/progress/broken.progress", "not json"),
            ("src/hanshu/a.hs", "A"),
        ],
    );
    let (_, key) = engine
        .create_subject(&sid, "viewer".into(), "agent".into(), Role::Viewer)
        .unwrap();
    let (_, viewer) = engine.login(&key, "view", 1000).unwrap();
    let plan = engine
        .plan_file_operations(
            &viewer.id,
            &[request(FileOperationKind::Write, "src/hanshu/a.hs", None)],
        )
        .unwrap();
    assert!(engine
        .resource_relations(&viewer.id, "src/progress/broken.progress")
        .unwrap()
        .relations
        .is_empty());
    assert_eq!(
        engine
            .acquire_files(&viewer.id, &plan.lease_paths, false, 1001)
            .unwrap_err()
            .code,
        "forbidden"
    );
    assert!(engine.snapshot(&sid).unwrap().leases.is_empty());
}

#[test]
fn invalid_paths_type_changing_moves_and_conflicting_requests_fail_without_side_effects() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, sid) = setup(dir.path(), &[("src/hanshu/a.hs", "A")]);
    for path in [".hanshu/service/owner-key", "../outside", "assets/CON.txt"] {
        assert!(engine.resource_relations(&sid, path).is_err());
        assert!(engine
            .plan_file_operations(&sid, &[request(FileOperationKind::Write, path, None)])
            .is_err());
    }
    assert!(engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Move,
                "src/hanshu/a.hs",
                Some("src/progress/a.progress")
            )]
        )
        .is_err());
    assert!(engine
        .plan_file_operations(
            &sid,
            &[
                request(
                    FileOperationKind::Move,
                    "src/hanshu/a.hs",
                    Some("src/hanshu/b.hs")
                ),
                request(FileOperationKind::Remove, "src/hanshu/a.hs", None)
            ]
        )
        .is_err());
    assert_eq!(
        fs::read_to_string(dir.path().join("src/hanshu/a.hs")).unwrap(),
        "A"
    );
}

#[test]
fn unsaved_owned_resources_have_relations_in_query_and_plan() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, sid) = setup(dir.path(), &[]);
    let path = "assets/zh_cn/lang_progress/new.lang";
    let facts = engine.resource_relations(&sid, path).unwrap();
    assert_eq!(facts.relations.len(), 1);
    assert_eq!(facts.relations[0].from, "src/progress/new.progress");
    let plan = engine
        .plan_file_operations(&sid, &[request(FileOperationKind::Write, path, None)])
        .unwrap();
    assert_eq!(plan.relations, facts.relations);
    assert_eq!(plan.authorities[0].source_kind.as_deref(), Some("progress"));
    let voice = engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Mkdir,
                "assets/zh_cn/voice_progress/new",
                None,
            )],
        )
        .unwrap();
    assert!(voice
        .relations
        .iter()
        .any(|relation| relation.from == "src/progress/new.progress"
            && relation.to == "assets/zh_cn/voice_progress/new"));
}

#[test]
fn mixed_ownership_voice_directories_never_cascade_unrelated_sources() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            ("src/hanshu/a.hs", "A"),
            ("src/hanshu/a/b.hs", "B"),
            ("assets/en_us/voice_hs/a/line.ogg", "A audio"),
            ("assets/en_us/voice_hs/a/b/line.ogg", "B audio"),
        ],
    );
    for operation in [
        request(FileOperationKind::Remove, "src/hanshu/a.hs", None),
        request(
            FileOperationKind::Move,
            "src/hanshu/a.hs",
            Some("src/hanshu/c.hs"),
        ),
    ] {
        assert_eq!(
            engine
                .plan_file_operations(&sid, &[operation])
                .unwrap_err()
                .code,
            "invalid"
        );
    }
    // Adding an explicit directory deletion does not make a source cascade legitimate.
    assert!(engine
        .plan_file_operations(
            &sid,
            &[
                request(FileOperationKind::Remove, "assets/en_us/voice_hs/a", None),
                request(FileOperationKind::Remove, "src/hanshu/a.hs", None)
            ]
        )
        .is_err());
    assert!(dir
        .path()
        .join("assets/en_us/voice_hs/a/b/line.ogg")
        .exists());
    // Removing both sources explicitly is safe, and overlapping physical roots collapse.
    let plan = engine
        .plan_file_operations(
            &sid,
            &[
                request(FileOperationKind::Remove, "src/hanshu/a.hs", None),
                request(FileOperationKind::Remove, "src/hanshu/a/b.hs", None),
            ],
        )
        .unwrap();
    assert_eq!(plan.operations.len(), 3);
    let changes = changes(&mut engine, &sid, &plan);
    assert_eq!(
        commit(&mut engine, &sid, changes).status,
        FileTransactionStatus::Committed
    );
    assert!(!dir.path().join("assets/en_us/voice_hs/a").exists());
}

#[test]
fn arbitrary_files_cannot_enter_typed_sources_through_move_or_directory_move() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            ("meta/docs/malformed.txt", "not progress JSON"),
            ("meta/imports/injected.progress", "not progress JSON"),
        ],
    );
    for operation in [
        request(
            FileOperationKind::Move,
            "meta/docs/malformed.txt",
            Some("src/progress/injected.progress"),
        ),
        request(
            FileOperationKind::Move,
            "meta/docs/malformed.txt",
            Some("meta/docs/injected.progress"),
        ),
        request(
            FileOperationKind::Move,
            "meta/imports",
            Some("src/progress"),
        ),
    ] {
        assert_eq!(
            engine
                .plan_file_operations(&sid, &[operation])
                .unwrap_err()
                .code,
            "invalid"
        );
    }
    let paths = vec![
        "meta/docs/malformed.txt".into(),
        "src/progress/injected.progress".into(),
    ];
    let leases = engine.acquire_files(&sid, &paths, false, 1001).unwrap();
    let version = engine
        .files_snapshot(&sid)
        .unwrap()
        .entries
        .into_iter()
        .find(|file| file.path == paths[0])
        .unwrap()
        .version;
    let change = FileChange {
        op: "move".into(),
        path: paths[0].clone(),
        destination: Some(paths[1].clone()),
        version: Some(version),
        destination_version: None,
        content: None,
        lease_id: leases
            .iter()
            .find(|lease| lease.resource_id == format!("file:{}", paths[0]))
            .unwrap()
            .id
            .clone(),
    };
    assert_eq!(
        commit(&mut engine, &sid, vec![change]).error.unwrap().code,
        "invalid"
    );
    assert!(dir.path().join("meta/docs/malformed.txt").exists());
    assert!(!dir.path().join("src/progress/injected.progress").exists());
}

#[test]
fn creating_or_moving_a_nested_source_cannot_reassign_another_sources_voice() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            ("src/hanshu/a.hs", "A"),
            ("src/hanshu/c.hs", "C"),
            ("assets/en_us/voice_hs/a/sub/line.ogg", "A audio"),
        ],
    );
    engine
        .acquire_files(&sid, &["src/hanshu/a.hs".into()], false, 1000)
        .unwrap();
    let (_, key) = engine
        .create_subject(&sid, "editor".into(), "agent".into(), Role::Editor)
        .unwrap();
    let (_, editor) = engine.login(&key, "B", 1000).unwrap();
    let nested_source = "src/hanshu/a/sub.hs";
    assert!(engine
        .plan_file_operations(
            &editor.id,
            &[request(FileOperationKind::Write, nested_source, None)]
        )
        .is_err());
    assert!(engine
        .plan_file_operations(
            &editor.id,
            &[request(
                FileOperationKind::Move,
                "src/hanshu/c.hs",
                Some(nested_source)
            )]
        )
        .is_err());
    let lease = engine
        .acquire_files(&editor.id, &[nested_source.into()], false, 1000)
        .unwrap()
        .remove(0);
    let change = FileChange {
        op: "write".into(),
        path: nested_source.into(),
        version: None,
        destination: None,
        destination_version: None,
        content: Some(STANDARD.encode("new nested source")),
        lease_id: lease.id,
    };
    assert_eq!(
        commit(&mut engine, &editor.id, vec![change])
            .error
            .unwrap()
            .code,
        "invalid"
    );
    assert!(!dir.path().join(nested_source).exists());
    let plan = engine
        .plan_file_operations(
            &editor.id,
            &[request(
                FileOperationKind::Write,
                "assets/en_us/voice_hs/a/sub/line.ogg",
                None,
            )],
        )
        .unwrap();
    assert!(plan.lease_paths.contains(&"src/hanshu/a.hs".into()));
    assert_eq!(
        engine
            .acquire_files(&editor.id, &plan.lease_paths, false, 1001)
            .unwrap_err()
            .code,
        "locked"
    );
}

#[test]
fn uppercase_source_extensions_keep_schema_and_actual_source_authority() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            ("src/hanshu/Story.HS", "story"),
            ("assets/zh_cn/lang_hs/Story.LANG", "title=story"),
            ("meta/raw.txt", "not JSON"),
        ],
    );
    let plan = engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Write,
                "assets/zh_cn/lang_hs/Story.LANG",
                None,
            )],
        )
        .unwrap();
    assert_eq!(plan.authorities[0].authority_path, "src/hanshu/Story.HS");
    assert!(plan.lease_paths.contains(&"src/hanshu/Story.HS".into()));
    assert!(!plan.lease_paths.contains(&"src/hanshu/Story.hs".into()));
    let removal = engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Remove,
                "src/hanshu/Story.HS",
                None,
            )],
        )
        .unwrap();
    assert!(removal
        .operations
        .iter()
        .any(|operation| operation.path == "assets/zh_cn/lang_hs/Story.LANG"));
    assert!(engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Move,
                "meta/raw.txt",
                Some("src/progress/Injected.PROGRESS")
            )]
        )
        .is_err());
    let plan = engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Write,
                "src/progress/Invalid.PROGRESS",
                None,
            )],
        )
        .unwrap();
    assert_eq!(plan.authorities[0].source_kind.as_deref(), Some("progress"));
    let submitted = changes(&mut engine, &sid, &plan);
    assert_eq!(
        commit(&mut engine, &sid, submitted).error.unwrap().code,
        "invalid"
    );
    assert!(!dir.path().join("src/progress/Invalid.PROGRESS").exists());
}
