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
fn display_text_languages_follow_item_and_entity_source_transactions() {
    for (kind, directory) in [("item", "items"), ("entity", "entities"), ("shop", "shop")] {
        let dir = tempfile::tempdir().unwrap();
        let source = format!("src/{directory}/a.{kind}");
        let destination = format!("src/{directory}/renamed.{kind}");
        let zh = format!("assets/zh_cn/lang_{kind}/a.lang");
        let en = format!("assets/en_us/lang_{kind}/a.lang");
        let next_zh = format!("assets/zh_cn/lang_{kind}/renamed.lang");
        let next_en = format!("assets/en_us/lang_{kind}/renamed.lang");
        let (mut engine, sid) = setup(
            dir.path(),
            &[
                (&source, "source"),
                (&zh, r#"{"display.custom_name":"名称"}"#),
                (&en, r#"{"display.custom_name":"Name"}"#),
            ],
        );
        let authority = engine
            .plan_file_operations(&sid, &[request(FileOperationKind::Write, &zh, None)])
            .unwrap();
        assert!(authority.lease_paths.contains(&source));
        let plan = engine
            .plan_file_operations(
                &sid,
                &[request(
                    FileOperationKind::Move,
                    &source,
                    Some(&destination),
                )],
            )
            .unwrap();
        assert_eq!(plan.operations.len(), 3);
        assert!(plan
            .operations
            .iter()
            .any(|op| op.path == zh && op.destination.as_deref() == Some(next_zh.as_str())));
        assert!(plan
            .operations
            .iter()
            .any(|op| op.path == en && op.destination.as_deref() == Some(next_en.as_str())));
        let edits = changes(&mut engine, &sid, &plan);
        assert!(commit(&mut engine, &sid, edits).error.is_none());
        assert!(!dir.path().join(&zh).exists());
        assert!(dir.path().join(&next_zh).exists());
        assert!(dir.path().join(&next_en).exists());
        let historical = engine
            .history_tree_scoped(&sid, 1, Some(&destination))
            .unwrap();
        assert!(historical.entries.iter().any(|entry| entry.path == source));
        assert!(historical.entries.iter().any(|entry| entry.path == zh));
        assert!(historical.entries.iter().any(|entry| entry.path == en));
        let plan = engine
            .plan_file_operations(
                &sid,
                &[request(FileOperationKind::Remove, &destination, None)],
            )
            .unwrap();
        assert_eq!(plan.operations.len(), 3);
        let edits = changes(&mut engine, &sid, &plan);
        assert!(commit(&mut engine, &sid, edits).error.is_none());
        assert!(!dir.path().join(&destination).exists());
        assert!(!dir.path().join(&next_zh).exists());
        assert!(!dir.path().join(&next_en).exists());
    }
}

#[test]
fn stale_display_translation_rejects_source_and_all_language_writes() {
    let dir = tempfile::tempdir().unwrap();
    let source = "src/items/a.item";
    let zh = "assets/zh_cn/lang_item/a.lang";
    let en = "assets/en_us/lang_item/a.lang";
    let (mut engine, sid) = setup(
        dir.path(),
        &[
            (source, "original source"),
            (zh, "original zh"),
            (en, "original en"),
        ],
    );
    let plan = engine
        .plan_file_operations(
            &sid,
            &[
                request(FileOperationKind::Write, source, None),
                request(FileOperationKind::Write, zh, None),
                request(FileOperationKind::Write, en, None),
            ],
        )
        .unwrap();
    let edits = changes(&mut engine, &sid, &plan);
    fs::write(dir.path().join(en), "concurrent en").unwrap();
    let receipt = commit(&mut engine, &sid, edits);
    assert_eq!(receipt.error.unwrap().code, "conflict");
    assert_eq!(
        fs::read_to_string(dir.path().join(source)).unwrap(),
        "original source"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join(zh)).unwrap(),
        "original zh"
    );
    assert_eq!(
        fs::read_to_string(dir.path().join(en)).unwrap(),
        "concurrent en"
    );
}

#[test]
fn relations_are_facts_and_reference_targets_are_never_leased_or_cascaded() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, sid) = setup(
        dir.path(),
        &[
            (
                "src/quest/a.quest",
                r#"{"rewardKits":["shared","missing.kit"]}"#,
            ),
            ("src/gift/shared.kit", "shared"),
            ("assets/zh_cn/lang_quest/a.lang", "title=A"),
        ],
    );
    let facts = engine
        .resource_relations(&sid, "src/quest/a.quest")
        .unwrap();
    assert_eq!(facts.relations.len(), 3);
    assert!(facts
        .relations
        .iter()
        .any(|relation| relation.kind == ResourceRelationKind::Reference
            && relation.to == "src/gift/missing.kit"));
    for operation in [FileOperationKind::Write, FileOperationKind::Remove] {
        let plan = engine
            .plan_file_operations(&sid, &[request(operation, "src/quest/a.quest", None)])
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
    assert_eq!(incoming.relations[0].from, "src/quest/a.quest");
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
            ("src/quest/broken.quest", "not json"),
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
        .resource_relations(&viewer.id, "src/quest/broken.quest")
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
                Some("src/quest/a.quest")
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
    let path = "assets/zh_cn/lang_quest/new.lang";
    let facts = engine.resource_relations(&sid, path).unwrap();
    assert_eq!(facts.relations.len(), 1);
    assert_eq!(facts.relations[0].from, "src/quest/new.quest");
    let plan = engine
        .plan_file_operations(&sid, &[request(FileOperationKind::Write, path, None)])
        .unwrap();
    assert_eq!(plan.relations, facts.relations);
    assert_eq!(plan.authorities[0].source_kind.as_deref(), Some("quest"));
    let voice = engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Mkdir,
                "assets/zh_cn/voice_quest/new",
                None,
            )],
        )
        .unwrap();
    assert!(voice
        .relations
        .iter()
        .any(|relation| relation.from == "src/quest/new.quest"
            && relation.to == "assets/zh_cn/voice_quest/new"));
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
            ("meta/imports/injected.quest", "not progress JSON"),
        ],
    );
    for operation in [
        request(
            FileOperationKind::Move,
            "meta/docs/malformed.txt",
            Some("src/quest/injected.quest"),
        ),
        request(
            FileOperationKind::Move,
            "meta/docs/malformed.txt",
            Some("meta/docs/injected.quest"),
        ),
        request(
            FileOperationKind::Move,
            "meta/imports",
            Some("src/quest"),
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
        "src/quest/injected.quest".into(),
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
    assert!(!dir.path().join("src/quest/injected.quest").exists());
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
                Some("src/quest/Injected.QUEST")
            )]
        )
        .is_err());
    let plan = engine
        .plan_file_operations(
            &sid,
            &[request(
                FileOperationKind::Write,
                "src/quest/Invalid.QUEST",
                None,
            )],
        )
        .unwrap();
    assert_eq!(plan.authorities[0].source_kind.as_deref(), Some("quest"));
    let mut submitted = changes(&mut engine, &sid, &plan);
    // 带单进度 format 的残缺 JSON 须在提交时被校验拒绝
    submitted[0].content = Some(STANDARD.encode(r#"{"format":"hanshu.progress","version":1}"#));
    assert_eq!(
        commit(&mut engine, &sid, submitted).error.unwrap().code,
        "invalid"
    );
    assert!(!dir.path().join("src/quest/Invalid.QUEST").exists());
}

#[test]
fn kit_script_reference_does_not_grant_lease_or_cascade_deletion() {
    let dir = tempfile::tempdir().unwrap();
    let (engine, sid) = setup(
        dir.path(),
        &[
            ("src/gift/a.kit", r#"{"script":[{"ref":"reward.py"},{"ref":"second"}]}"#),
            ("src/script/kit/reward.py.py", "pass"),
        ],
    );
    let facts = engine.resource_relations(&sid, "src/gift/a.kit").unwrap();
    assert!(facts.relations.iter().any(
        |r| r.role == ResourceRelationRole::KitScript && r.to == "src/script/kit/reward.py.py"
    ));
    assert!(facts.relations.iter().any(|r| r.role == ResourceRelationRole::KitScript && r.to == "src/script/kit/second.py"));
    let plan = engine
        .plan_file_operations(
            &sid,
            &[request(FileOperationKind::Remove, "src/gift/a.kit", None)],
        )
        .unwrap();
    assert!(plan
        .operations
        .iter()
        .all(|op| op.path != "src/script/kit/reward.py.py"));
    assert!(plan
        .lease_paths
        .iter()
        .all(|path| path != "src/script/kit/reward.py.py"));
}
