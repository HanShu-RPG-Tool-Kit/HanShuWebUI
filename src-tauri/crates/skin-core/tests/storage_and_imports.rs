//! Storage + import pipeline integration tests, mirroring the old Node
//! routes/normalize test suite against temporary libraries.

use skin_core::codec::{decode_skin_code, encode_skin_code, SkinModel};
use skin_core::imports::{ImportInput, ImportManager, JobState};
use skin_core::normalize::rgba_to_png;
use skin_core::storage::{BatchPatch, LibraryQuery, PatchEntry, Storage};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

fn fixture(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn temp_root(tag: &str) -> std::path::PathBuf {
    tempfile::TempDir::new().unwrap().keep().join(tag)
}

fn sample_code() -> String {
    std::fs::read_to_string(fixture("modern-classic.skincode"))
        .unwrap()
        .trim()
        .to_string()
}

fn sample_code_2() -> String {
    std::fs::read_to_string(fixture("modern-slim.skincode"))
        .unwrap()
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// schema load / migrate
// ---------------------------------------------------------------------------

#[test]
fn loads_v3_library() {
    let root = temp_root("v3");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::copy(fixture("library-v3.json"), root.join("library.json")).unwrap();
    let storage = Storage::open(&root).unwrap();
    let page = storage.list_entries(&LibraryQuery::default());
    assert_eq!(page.total, 2);
    let (_, tags) = storage.list_tags();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].name, "精灵");
    let (_, folders) = storage.folder_tree_with_stats();
    assert_eq!(folders.len(), 1);
    // revision preserved from file
    assert_eq!(storage.revision(), 7);
}

#[test]
fn migrates_v2_to_v3() {
    let root = temp_root("v2");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::copy(fixture("library-v2.json"), root.join("library.json")).unwrap();
    let storage = Storage::open(&root).unwrap();
    let page = storage.list_entries(&LibraryQuery::default());
    assert_eq!(page.total, 2);
    // v2 entries become library-root (folder_id = None)
    for e in &page.entries {
        assert_eq!(e.folder_id, None);
    }
    // persisted as v4 now
    let raw = std::fs::read_to_string(root.join("library.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["schemaVersion"], 5);
    assert!(v.get("tags").is_none());
    assert_eq!(v["folders"].as_array().unwrap().len(), 0);
}

#[test]
fn migrates_v1_dedupes_nfc_tags_and_keeps_backup() {
    let root = temp_root("v1");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::copy(fixture("library-v1.json"), root.join("library.json")).unwrap();
    let storage = Storage::open(&root).unwrap();
    let (_, tags) = storage.list_tags();
    // "精灵" and "精灵 " (trailing space) merge; "战士" stays → 2 unique tags
    let names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"精灵"));
    assert!(names.contains(&"战士"));
    assert_eq!(tags.len(), 2);
    // untouched v1 backup kept under the dedicated name
    assert!(root.join("library.json.v1-migration-backup").exists());
    // entry keeps its id and freeform tags
    let page = storage.list_entries(&LibraryQuery::default());
    assert_eq!(page.total, 1);
    assert_eq!(page.entries[0].entry_id, "66666666-6666-4666-8666-666666666666");
    assert_eq!(page.entries[0].tags.len(), 2);
    // migration is idempotent: reopening does not duplicate tags
    drop(storage);
    let storage2 = Storage::open(&root).unwrap();
    let (_, tags2) = storage2.list_tags();
    assert_eq!(tags2.len(), 2);
}

#[test]
fn refuses_newer_schema() {
    let root = temp_root("v9");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("library.json"),
        r#"{"schemaVersion": 9, "revision": 1, "folders": [], "entries": []}"#,
    )
    .unwrap();
    let err = match Storage::open(&root) { Err(e) => e, Ok(_) => panic!("expected error") };
    assert!(err.to_string().contains("newer than supported"));
}

#[test]
fn corrupt_library_and_backup_refuses_empty_overwrite() {
    let root = temp_root("corrupt");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("library.json"), "{not json").unwrap();
    std::fs::write(root.join("library.json.bak"), "{also not json").unwrap();
    let err = match Storage::open(&root) { Err(e) => e, Ok(_) => panic!("expected error") };
    assert!(err.to_string().contains("refusing to overwrite"));
    // and the corrupt files are still there
    assert!(root.join("library.json").exists());
}

// ---------------------------------------------------------------------------
// objects + GC
// ---------------------------------------------------------------------------

#[test]
fn objects_round_trip_and_gc() {
    let root = temp_root("obj");
    let storage = Storage::open(&root).unwrap();
    let (skin_id, model) = storage.put_object(&sample_code()).unwrap();
    assert_eq!(model, SkinModel::Classic);
    assert!(root.join("objects").join(&skin_id[..2]).join(format!("{skin_id}.hskin")).exists());

    let obj = storage.get_object(&skin_id).unwrap().unwrap();
    assert_eq!(obj.0.trim(), sample_code());

    // GC with no references removes it; with a staged ref it is protected.
    let removed = storage.gc_objects(&HashSet::new()).unwrap();
    assert!(removed.contains(&skin_id));
    assert!(!root.join("objects").join(&skin_id[..2]).join(format!("{skin_id}.hskin")).exists());

    let (skin_id2, _) = storage.put_object(&sample_code()).unwrap();
    let mut protected = HashSet::new();
    protected.insert(skin_id2.clone());
    let removed2 = storage.gc_objects(&protected).unwrap();
    assert!(!removed2.contains(&skin_id2));
}

#[test]
fn bad_skin_id_rejected() {
    let root = temp_root("badid");
    let storage = Storage::open(&root).unwrap();
    assert!(storage.get_object("../etc/passwd").is_err());
    assert!(storage.get_object("ABCDEF").is_err());
    assert!(storage.get_object(&"a".repeat(64)).unwrap().is_none());
}

// ---------------------------------------------------------------------------
// entries / tags / folders semantics
// ---------------------------------------------------------------------------

fn storage_with_entry() -> (std::path::PathBuf, Storage, String) {
    let root = temp_root("entry");
    let storage = Storage::open(&root).unwrap();
    let (skin_id, model) = storage.put_object(&sample_code()).unwrap();
    let entry = storage
        .add_entry(skin_core::storage::AddEntryInput {
            skin_id: skin_id.clone(),
            name: "测试一".into(),
            active: true,
            tags: vec![],
            folder_id: None,
            favorite: false,
            model,
            source: skin_core::storage::schema::EntrySource::SkinCode,
            provenance: Default::default(),
            license: Default::default(),
            note: String::new(),
        })
        .unwrap();
    (root, storage, entry.entry_id)
}

#[test]
fn rename_keeps_skin_id_and_stale_revision_rejected() {
    let (_root, storage, entry_id) = storage_with_entry();
    let entry = storage.get_entry(&entry_id).unwrap();
    let updated = storage
        .patch_entry(&entry_id, entry.revision, PatchEntry {
            name: Some("改名".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(updated.name, "改名");
    assert_eq!(updated.skin_id, entry.skin_id);
    // stale revision now fails
    let err = storage
        .patch_entry(&entry_id, entry.revision, PatchEntry {
            name: Some("再次".into()),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(err.code(), "REVISION_MISMATCH");
}

#[test]
fn same_skin_id_multiple_entries() {
    let (_root, storage, entry_id) = storage_with_entry();
    let entry = storage.get_entry(&entry_id).unwrap();
    storage
        .add_entry(skin_core::storage::AddEntryInput {
            skin_id: entry.skin_id.clone(),
            name: "同对象第二条例".into(),
            active: true,
            tags: vec![],
            folder_id: None,
            favorite: false,
            model: SkinModel::Classic,
            source: skin_core::storage::schema::EntrySource::SkinCode,
            provenance: Default::default(),
            license: Default::default(),
            note: String::new(),
        })
        .unwrap();
    assert_eq!(storage.entries_using(&entry.skin_id).len(), 2);
    // deleting one keeps the other and the object
    storage.remove_entry(&entry_id).unwrap();
    assert_eq!(storage.entries_using(&entry.skin_id).len(), 1);
}

#[test]
fn freeform_tags_and_three_state_folder() {
    let root = temp_root("tags");
    let storage = Storage::open(&root).unwrap();

    // entry with folder + tags
    let (skin_id, model) = storage.put_object(&sample_code()).unwrap();
    let folder = storage.create_folder("主角", None).unwrap();
    let entry = storage
        .add_entry(skin_core::storage::AddEntryInput {
            skin_id,
            name: "带标签".into(),
            active: true,
            tags: vec!["森林精灵".into()],
            folder_id: Some(folder.folder_id.clone()),
            favorite: false,
            model,
            source: skin_core::storage::schema::EntrySource::SkinCode,
            provenance: Default::default(),
            license: Default::default(),
            note: String::new(),
        })
        .unwrap();

    let (affected, _) = storage.rename_tag("森林精灵", "精灵").unwrap();
    assert_eq!(affected, 1);
    assert_eq!(
        storage.get_entry(&entry.entry_id).unwrap().tags,
        vec!["精灵".to_string()]
    );
    let (affected, _) = storage.delete_tag("精灵").unwrap();
    assert_eq!(affected, 1);
    assert!(storage.get_entry(&entry.entry_id).unwrap().tags.is_empty());

    // three-state folderId on patch: missing = unchanged, null = unfile, value = move
    let entry = storage.get_entry(&entry.entry_id).unwrap();
    storage
        .patch_entry(&entry.entry_id, entry.revision, PatchEntry::default())
        .unwrap();
    let e = storage.get_entry(&entry.entry_id).unwrap();
    assert_eq!(e.folder_id, Some(folder.folder_id.clone())); // unchanged

    let e2 = storage
        .patch_entry(&entry.entry_id, e.revision, PatchEntry {
            folder_id: Some(skin_core::storage::PatchField::Null),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(e2.folder_id, None); // cleared

    let folder2 = storage.create_folder("配角", None).unwrap();
    let e3 = storage
        .patch_entry(&entry.entry_id, e2.revision, PatchEntry {
            folder_id: Some(skin_core::storage::PatchField::Value(folder2.folder_id.clone())),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(e3.folder_id, Some(folder2.folder_id.clone())); // moved

    // query three-state: no filter / null filter / folder filter
    assert_eq!(storage.list_entries(&LibraryQuery::default()).total, 1);
    assert_eq!(
        storage
            .list_entries(&LibraryQuery {
                folder_id: Some("nonexistent".into()),
                ..Default::default()
            })
            .total,
        0
    );
    // folder not empty → delete refused
    let err = storage.delete_folder(&folder2.folder_id).unwrap_err();
    assert_eq!(err.code(), "FOLDER_NOT_EMPTY");
}

#[test]
fn batch_patch_is_all_or_nothing() {
    let (_root, storage, entry_id) = storage_with_entry();
    // one valid + one invalid entry id → whole batch rejected
    let err = storage
        .batch_patch_entries(BatchPatch {
            entry_ids: vec![entry_id.clone(), "missing".into()],
            add_tags: Some(vec!["批量".into()]),
            remove_tags: None,
            folder_id: None,
            active: None,
            expected_revisions: None,
        })
        .unwrap_err();
    assert_eq!(err.code(), "NOT_FOUND");
    // entry untouched
    let e = storage.get_entry(&entry_id).unwrap();
    assert!(e.tags.is_empty());
    // valid batch applies
    let (updated, _) = storage
        .batch_patch_entries(BatchPatch {
            entry_ids: vec![entry_id.clone()],
            add_tags: Some(vec!["批量".into()]),
            remove_tags: None,
            folder_id: None,
            active: None,
            expected_revisions: None,
        })
        .unwrap();
    assert_eq!(updated, 1);
    assert_eq!(
        storage.get_entry(&entry_id).unwrap().tags,
        vec!["批量".to_string()]
    );
}

#[test]
fn restart_persistence() {
    let root = temp_root("restart");
    {
        let storage = Storage::open(&root).unwrap();
        let (skin_id, model) = storage.put_object(&sample_code()).unwrap();
        storage
            .add_entry(skin_core::storage::AddEntryInput {
                skin_id,
                name: "持久".into(),
                active: true,
                tags: vec!["重启".into()],
                folder_id: None,
                favorite: true,
                model,
                source: skin_core::storage::schema::EntrySource::SkinCode,
                provenance: Default::default(),
                license: Default::default(),
                note: String::new(),
            })
            .unwrap();
    }
    let storage = Storage::open(&root).unwrap();
    let page = storage.list_entries(&LibraryQuery::default());
    assert_eq!(page.total, 1);
    assert_eq!(page.entries[0].name, "持久");
    assert!(page.entries[0].favorite);
    assert_eq!(page.entries[0].tags, vec!["重启".to_string()]);
}

// ---------------------------------------------------------------------------
// import pipeline (offline kinds)
// ---------------------------------------------------------------------------

fn drive(mgr: &Arc<ImportManager>, input: ImportInput) -> skin_core::imports::ImportJob {
    let job = mgr.start(input);
    // Jobs run on the injected spawner; in tests we poll until terminal.
    for _ in 0..500 {
        let j = mgr.get(&job.job_id).unwrap();
        if matches!(j.state, JobState::Ready | JobState::Failed | JobState::Cancelled) {
            return j;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    panic!("job did not settle");
}

fn install_test_spawner() {
    skin_core::imports::set_spawn_hook(|fut| {
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(fut);
        });
    });
}

#[test]
fn skin_code_import_save_preview_restart() {
    let root = temp_root("import");
    let storage = Arc::new(Storage::open(&root).unwrap());
    let mgr = Arc::new(ImportManager::new(storage.clone()));
    install_test_spawner();

    let job = drive(&mgr, ImportInput::SkinCode { code: sample_code() });
    assert_eq!(job.state, JobState::Ready);
    let result = job.result.unwrap();
    let expected_id = std::fs::read_to_string(fixture("modern-classic.skinid"))
        .unwrap()
        .trim()
        .to_string();
    assert_eq!(result.skin_id, expected_id);

    // preview PNG was generated and decodes back to the same rgba
    let png = storage.get_preview_png(&result.skin_id).unwrap().unwrap();
    let back = skin_core::normalize::normalize_png(&png).unwrap();
    let (decoded, _) = decode_skin_code(&sample_code()).unwrap();
    assert_eq!(back.rgba, decoded.rgba);

    // save → entry exists; restart keeps it
    let entry = mgr
        .save_entry(&job.job_id, "导入的皮肤", vec![], vec![], None, false, None, None, None, None)
        .unwrap();
    assert_eq!(entry.name, "导入的皮肤");
    drop(mgr);
    drop(storage);
    let storage2 = Storage::open(&root).unwrap();
    assert_eq!(storage2.list_entries(&LibraryQuery::default()).total, 1);
}

#[test]
fn png_file_import_full_chain() {
    let root = temp_root("pngimport");
    let storage = Arc::new(Storage::open(&root).unwrap());
    let mgr = Arc::new(ImportManager::new(storage.clone()));
    install_test_spawner();

    let png_bytes = std::fs::read(fixture("legacy32-classic.png")).unwrap();
    let job = drive(
        &mgr,
        ImportInput::PngFile {
            bytes: png_bytes,
            file_name: "legacy.png".into(),
            model_override: SkinModel::Classic,
        },
    );
    assert_eq!(job.state, JobState::Ready, "{:?}", job.error);
    let result = job.result.unwrap();
    let expected_id = std::fs::read_to_string(fixture("legacy32-classic.skinid"))
        .unwrap()
        .trim()
        .to_string();
    assert_eq!(result.skin_id, expected_id);
    assert_eq!(result.suggested_name, "legacy");

    let entry = mgr
        .save_entry(&job.job_id, "旧版皮肤", vec![], vec![], None, false, None, None, None, None)
        .unwrap();
    assert!(matches!(
        entry.source,
        skin_core::storage::schema::EntrySource::PngFile { .. }
    ));
}

#[test]
fn portable_v2_and_v1_import() {
    let root = temp_root("portable");
    let storage = Arc::new(Storage::open(&root).unwrap());
    let mgr = Arc::new(ImportManager::new(storage.clone()));
    install_test_spawner();

    // v2 with tagPaths
    let v2 = std::fs::read(fixture("portable-v2.json")).unwrap();
    let job = drive(&mgr, ImportInput::SkinFile { bytes: v2, file_name: Some("便携.skin.json".into()) });
    assert_eq!(job.state, JobState::Ready, "{:?}", job.error);
    let result = job.result.clone().unwrap();
    assert_eq!(result.suggested_name, "便携皮肤");
    assert_eq!(
        result.suggested_tag_paths.unwrap(),
        vec![vec!["精灵".to_string(), "森林精灵".to_string()]]
    );
    // save materializes the tag paths
    let entry = mgr
        .save_entry(&job.job_id, "便携皮肤", vec![], vec![], None, false, None, None, None, None)
        .unwrap();
    assert_eq!(entry.tags, vec!["森林精灵".to_string()]);

    // v1 flat tags become entry tags
    let v1 = std::fs::read(fixture("portable-v1.json")).unwrap();
    let job1 = drive(&mgr, ImportInput::SkinFile { bytes: v1, file_name: None });
    assert_eq!(job1.state, JobState::Ready, "{:?}", job1.error);
    let entry1 = mgr
        .save_entry(&job1.job_id, "旧便携", vec![], vec![], None, false, None, None, None, None)
        .unwrap();
    assert_eq!(entry1.tags.len(), 2); // 精灵 + 战士
}

#[test]
fn portable_with_mismatched_skin_id_rejected() {
    let root = temp_root("mismatch");
    let storage = Arc::new(Storage::open(&root).unwrap());
    let mgr = Arc::new(ImportManager::new(storage.clone()));
    install_test_spawner();
    let mut v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("portable-v2.json")).unwrap())
            .unwrap();
    v["skinId"] = serde_json::json!("0".repeat(64));
    let job = drive(
        &mgr,
        ImportInput::SkinFile { bytes: serde_json::to_vec(&v).unwrap(), file_name: None },
    );
    assert_eq!(job.state, JobState::Failed);
    assert_eq!(job.error.unwrap().code, "FORMAT_ERROR");
}

#[test]
fn queued_job_cancelled() {
    let root = temp_root("cancel");
    let storage = Arc::new(Storage::open(&root).unwrap());
    let mgr = Arc::new(ImportManager::new(storage.clone()));
    // No spawn hook: the job stays queued (spawned nowhere), so cancel works.
    let job = mgr.start(ImportInput::SkinCode { code: sample_code() });
    let cancelled = mgr.cancel(&job.job_id).unwrap();
    assert_eq!(cancelled.state, JobState::Cancelled);
}

#[test]
fn malformed_skin_code_fails_with_stable_code() {
    let root = temp_root("badcode");
    let storage = Arc::new(Storage::open(&root).unwrap());
    let mgr = Arc::new(ImportManager::new(storage.clone()));
    install_test_spawner();
    let job = drive(&mgr, ImportInput::SkinCode { code: "hskin1:!!!!".into() });
    assert_eq!(job.state, JobState::Failed);
    assert_eq!(job.error.unwrap().code, "BAD_BASE64");
}

#[test]
fn encode_decode_roundtrip_via_storage() {
    let root = temp_root("roundtrip");
    let storage = Storage::open(&root).unwrap();
    // Two different skins → different ids; same skin + different model → different ids.
    let (id1, m1) = storage.put_object(&sample_code()).unwrap();
    let (id2, m2) = storage.put_object(&sample_code_2()).unwrap();
    assert_ne!(id1, id2);
    assert_eq!(m1, SkinModel::Classic);
    assert_eq!(m2, SkinModel::Slim);
    // re-put same code is idempotent
    let (id1b, _) = storage.put_object(&sample_code()).unwrap();
    assert_eq!(id1, id1b);
    // encode from rgba produces a decodable code with the same id
    let (decoded, _) = decode_skin_code(&sample_code()).unwrap();
    let re_encoded = encode_skin_code(SkinModel::Classic, &decoded.rgba).unwrap();
    let (_, re_id) = decode_skin_code(&re_encoded).unwrap();
    assert_eq!(re_id, id1);
    let _ = rgba_to_png(&decoded.rgba).unwrap();
}

// ---------------------------------------------------------------------------
// v4 metadata round-trip / filters / sorting / manifest (方案 §5–§7)
// ---------------------------------------------------------------------------

fn add_meta_entry(
    storage: &Storage,
    skin_id: &str,
    name: &str,
    active: bool,
    author: Option<&str>,
    license_name: Option<&str>,
    tags: Vec<String>,
    model: SkinModel,
) -> skin_core::storage::schema::LibraryEntry {
    storage
        .add_entry(skin_core::storage::AddEntryInput {
            skin_id: skin_id.to_string(),
            name: name.to_string(),
            active,
            tags,
            folder_id: None,
            favorite: false,
            model,
            source: skin_core::storage::schema::EntrySource::SkinCode,
            provenance: skin_core::storage::schema::Provenance {
                author: author.map(|s| s.to_string()),
                source_name: Some("Nameless".into()),
                source_url: Some("https://example.com/a".into()),
                source_note: None,
                original_created_at: None,
            },
            license: skin_core::storage::schema::LicenseInfo {
                status: if license_name.is_some() {
                    skin_core::storage::schema::LicenseStatus::Declared
                } else {
                    skin_core::storage::schema::LicenseStatus::Unspecified
                },
                name: license_name.map(|s| s.to_string()),
                url: None,
                note: None,
            },
            note: "备注内容".into(),
        })
        .unwrap()
}

#[test]
fn v4_metadata_round_trip_and_persistence() {
    let root = temp_root("v4meta");
    let (skin_id, model) = {
        let storage = Storage::open(&root).unwrap();
        let (skin_id, model) = storage.put_object(&sample_code()).unwrap();
        add_meta_entry(&storage, &skin_id, "守卫", false, Some("Alice"), Some("MIT"), vec![], model);
        (skin_id, model)
    };
    // Reopen: all v4 fields survive a restart.
    let storage = Storage::open(&root).unwrap();
    let page = storage.list_entries(&LibraryQuery { search: Some("守卫".into()), ..Default::default() });
    assert_eq!(page.total, 1);
    let e = &page.entries[0];
    assert!(!e.active);
    assert_eq!(e.provenance.author.as_deref(), Some("Alice"));
    assert_eq!(e.license.status, skin_core::storage::schema::LicenseStatus::Declared);
    assert_eq!(e.license.name.as_deref(), Some("MIT"));
    assert_eq!(e.note, "备注内容");
    assert_eq!(e.skin_id, skin_id);
    assert_eq!(e.model, model);
    // schema version on disk is 4
    let raw = std::fs::read_to_string(root.join("library.json")).unwrap();
    assert!(raw.contains("\"schemaVersion\": 5"));
    assert!(!raw.contains("\"tagIds\""));
}

#[test]
fn positive_and_negative_filters_with_sorting_and_paging() {
    let root = temp_root("filters");
    let storage = Storage::open(&root).unwrap();
    let (id_a, _) = storage.put_object(&sample_code()).unwrap();
    let (id_b, _) = storage.put_object(&sample_code_2()).unwrap();

    // 守卫+已启用+MIT;守卫+已禁用+未声明;现代+已启用
    add_meta_entry(&storage, &id_a, "A", true, Some("Alice"), Some("MIT"), vec!["守卫".into()], SkinModel::Classic);
    add_meta_entry(&storage, &id_a, "B", false, Some("Bob"), None, vec!["守卫".into()], SkinModel::Classic);
    add_meta_entry(&storage, &id_b, "C", true, Some("Alice"), None, vec!["现代".into()], SkinModel::Slim);

    // 包含【守卫】 排除【现代】 → A、B
    let q = LibraryQuery {
        tags: vec!["守卫".into()],
        exclude_tags: vec!["现代".into()],
        ..Default::default()
    };
    let page = storage.list_entries(&q);
    assert_eq!(page.total, 2);

    // + 仅已启用 → A
    let page = storage.list_entries(&LibraryQuery { active: Some(true), ..q.clone() });
    assert_eq!(page.total, 1);
    assert_eq!(page.entries[0].name, "A");

    // + 排除未声明协议(即 licenseUnspecified=false)→ A
    let page = storage.list_entries(&LibraryQuery {
        license_unspecified: Some(false),
        ..q.clone()
    });
    assert_eq!(page.total, 1);
    assert_eq!(page.entries[0].name, "A");

    // 仅未声明协议 → B、C
    let page = storage.list_entries(&LibraryQuery {
        license_unspecified: Some(true),
        ..Default::default()
    });
    assert_eq!(page.total, 2);

    // 作者筛选
    let page = storage.list_entries(&LibraryQuery { author: Some("alice".into()), ..Default::default() });
    assert_eq!(page.total, 2);

    // 模型筛选
    let page = storage.list_entries(&LibraryQuery { models: vec![SkinModel::Slim], ..Default::default() });
    assert_eq!(page.total, 1);
    assert_eq!(page.entries[0].name, "C");

    // 稳定排序:名称升序,同值按 entryId;分页无重复无遗漏
    let all = storage.list_entries(&LibraryQuery {
        sort_by: Some(skin_core::storage::EntrySortBy::Name),
        sort_direction: Some(skin_core::storage::SortDirection::Asc),
        ..Default::default()
    });
    let names: Vec<&str> = all.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["A", "B", "C"]);

    let p1 = storage.list_entries(&LibraryQuery { page: Some(1), page_size: Some(2), ..Default::default() });
    let p2 = storage.list_entries(&LibraryQuery { page: Some(2), page_size: Some(2), ..Default::default() });
    assert_eq!(p1.total, 3);
    assert_eq!(p1.entries.len(), 2);
    assert_eq!(p2.entries.len(), 1);
    let ids: Vec<&str> = p1.entries.iter().chain(p2.entries.iter()).map(|e| e.entry_id.as_str()).collect();
    let uniq: std::collections::HashSet<&str> = ids.iter().copied().collect();
    assert_eq!(ids.len(), uniq.len());
}

#[test]
fn usable_manifest_contains_only_active_entries() {
    let root = temp_root("manifest");
    let storage = Storage::open(&root).unwrap();
    let (skin_id, model) = storage.put_object(&sample_code()).unwrap();
    add_meta_entry(&storage, &skin_id, "启用项", true, Some("Alice"), Some("CC BY 4.0"), vec![], model);
    add_meta_entry(&storage, &skin_id, "禁用项", false, Some("Bob"), None, vec![], model);

    let usable = storage.list_usable_entries();
    assert_eq!(usable.len(), 1);
    assert_eq!(usable[0].name, "启用项");
    assert_eq!(usable[0].license.name.as_deref(), Some("CC BY 4.0"));
    // 禁用不删除内容对象
    assert!(storage.get_object(&skin_id).unwrap().is_some());
}

#[test]
fn batch_active_conflict_is_all_or_nothing() {
    let root = temp_root("batchactive");
    let storage = Storage::open(&root).unwrap();
    let (skin_id, model) = storage.put_object(&sample_code()).unwrap();
    let e1 = add_meta_entry(&storage, &skin_id, "一", true, None, None, vec![], model);
    let e2 = add_meta_entry(&storage, &skin_id, "二", true, None, None, vec![], model);
    // Bump e2's revision so the stale expected revision is genuinely stale.
    let bumped = storage
        .patch_entry(&e2.entry_id, e2.revision, PatchEntry {
            favorite: Some(true),
            ..Default::default()
        })
        .unwrap();

    // Stale expected revision for the second entry → whole batch rejected.
    let err = storage
        .batch_patch_entries(BatchPatch {
            entry_ids: vec![e1.entry_id.clone(), e2.entry_id.clone()],
            active: Some(false),
            expected_revisions: Some(vec![e1.revision, e2.revision]),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(err.code(), "REVISION_MISMATCH");
    // Neither entry changed.
    assert!(storage.get_entry(&e1.entry_id).unwrap().active);
    assert!(storage.get_entry(&e2.entry_id).unwrap().active);

    // Correct revisions → both disabled.
    storage
        .batch_patch_entries(BatchPatch {
            entry_ids: vec![e1.entry_id.clone(), e2.entry_id.clone()],
            active: Some(false),
            expected_revisions: Some(vec![e1.revision, bumped.revision]),
            ..Default::default()
        })
        .unwrap();
    assert!(!storage.get_entry(&e1.entry_id).unwrap().active);
    assert!(!storage.get_entry(&e2.entry_id).unwrap().active);
}

#[test]
fn portable_v3_export_import_round_trip() {
    let root = temp_root("portable3");
    let storage = Storage::open(&root).unwrap();
    let (skin_id, model) = storage.put_object(&sample_code()).unwrap();
    let entry = add_meta_entry(&storage, &skin_id, "可转移", true, Some("Alice"), Some("MIT"), vec![], model);
    storage
        .patch_entry(&entry.entry_id, entry.revision, PatchEntry {
            tags: Some(vec!["守卫".into()]),
            ..Default::default()
        })
        .unwrap();

    // Serialize the v3 portable shape (as the export commands do).
    let entry = storage.get_entry(&entry.entry_id).unwrap();
    let obj = storage.get_object(&entry.skin_id).unwrap().unwrap();
    let portable = skin_core::storage::schema::PortableSkinFileV3 {
        schema_version: 3,
        name: entry.name.clone(),
        skin_id: entry.skin_id.clone(),
        skin_code: obj.0.clone(),
        model: entry.model,
        tag_paths: vec![vec!["守卫".into()]],
        active: entry.active,
        license: entry.license.clone(),
        provenance: entry.provenance.clone(),
        note: entry.note.clone(),
    };
    let bytes = serde_json::to_vec(&portable).unwrap();

    // Import into a fresh library via the pipeline.
    let root2 = temp_root("portable3b");
    let storage2 = Storage::open(&root2).unwrap();
    let mgr = Arc::new(ImportManager::new(Arc::new(Storage::open(&root2).unwrap())));
    install_test_spawner();
    let job = drive(&mgr, ImportInput::SkinFile { bytes, file_name: Some("可转移.skin.json".into()) });
    assert_eq!(job.state, JobState::Ready);
    let result = job.result.unwrap();
    assert_eq!(result.skin_id, skin_id);
    assert_eq!(result.suggested_active, Some(true));
    assert_eq!(result.suggested_license.unwrap().name.as_deref(), Some("MIT"));
    assert_eq!(result.suggested_provenance.unwrap().author.as_deref(), Some("Alice"));
    assert_eq!(result.suggested_note.as_deref(), Some("备注内容"));

    let saved = mgr
        .save_entry(&job.job_id, "新名字", vec![], vec![], None, false, None, None, None, None)
        .unwrap();
    assert_eq!(saved.skin_id, skin_id);
    assert_ne!(saved.entry_id, entry.entry_id); // new library → new entryId
    assert!(saved.active); // active carried from the file
    assert_eq!(saved.license.name.as_deref(), Some("MIT"));
    assert_eq!(saved.provenance.author.as_deref(), Some("Alice"));
    assert_eq!(saved.note, "备注内容");
    assert_eq!(saved.tags, vec!["守卫".to_string()]); // tagPaths flattened at save time
}
