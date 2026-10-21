use project_core::*;
use std::{fs, path::Path};

const SOURCE: &str = "src/progress/chapter/arrival.progress";
const LANG: &str = "assets/zh_cn/lang_progress/chapter/arrival.lang";

fn setup(root: &Path) -> (Engine, String, String) {
    fs::create_dir_all(root.join("src/progress/chapter")).unwrap();
    fs::create_dir_all(root.join("assets/zh_cn/lang_progress/chapter")).unwrap();
    fs::write(root.join(SOURCE), "{}").unwrap();
    fs::write(root.join(LANG), "title=arrival").unwrap();
    let mut engine = Engine::open_project(root).unwrap();
    let key = fs::read_to_string(root.join(".hanshu/service/owner-key")).unwrap();
    let (_, session) = engine.login(&key, "owner", 1000).unwrap();
    (engine, session.id, key)
}

fn presence(engine: &Engine, session: &str) -> FilePresence {
    engine
        .snapshot(session)
        .unwrap()
        .session
        .file_presence
        .unwrap()
}

#[test]
fn opening_is_viewing_without_a_lease_and_heartbeat_preserves_focus() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, owner, _) = setup(dir.path());
    engine
        .set_file_presence(&owner, Some(SOURCE.into()), 1001)
        .unwrap();
    assert_eq!(presence(&engine, &owner).activity, FileActivity::Viewing);
    assert_eq!(
        presence(&engine, &owner).authority_id,
        format!("file:{SOURCE}")
    );
    assert!(engine.snapshot(&owner).unwrap().leases.is_empty());
    engine.heartbeat(&owner, None, None, false, 2000).unwrap();
    assert_eq!(presence(&engine, &owner).path, SOURCE);
    engine.set_file_presence(&owner, None, 2001).unwrap();
    engine.heartbeat(&owner, None, None, false, 2002).unwrap();
    assert!(engine
        .snapshot(&owner)
        .unwrap()
        .session
        .file_presence
        .is_none());
}

#[test]
fn unsaved_public_files_are_allowed_but_directories_and_private_paths_are_not() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, owner, _) = setup(dir.path());
    engine
        .set_file_presence(&owner, Some("src/progress/new.progress".into()), 1001)
        .unwrap();
    assert_eq!(presence(&engine, &owner).activity, FileActivity::Viewing);
    for (path, code) in [
        ("src/progress", "invalid"),
        (".hanshu/service/owner-key", "forbidden"),
        (".hanshu/service/new.progress", "forbidden"),
        ("src/../../secrets", "invalid"),
        ("C:/windows/file", "invalid"),
    ] {
        assert_eq!(
            engine
                .set_file_presence(&owner, Some(path.into()), 1002)
                .unwrap_err()
                .code,
            code
        );
    }
    // Failed presence requests must not clear the previous valid focus.
    assert_eq!(presence(&engine, &owner).path, "src/progress/new.progress");
}

#[test]
fn editing_is_server_derived_and_related_files_share_source_authority() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, owner, _) = setup(dir.path());
    engine
        .set_file_presence(&owner, Some(LANG.into()), 1001)
        .unwrap();
    assert_eq!(
        presence(&engine, &owner).authority_id,
        format!("file:{SOURCE}")
    );
    assert_eq!(presence(&engine, &owner).activity, FileActivity::Viewing);
    let leases = engine
        .acquire_files(&owner, &[LANG.into()], false, 1002)
        .unwrap();
    assert_eq!(presence(&engine, &owner).activity, FileActivity::Editing);
    let source = leases
        .iter()
        .find(|lease| lease.resource_id == format!("file:{SOURCE}"))
        .unwrap();
    engine
        .release(&owner, &source.resource_id, &source.id, 1003)
        .unwrap();
    assert_eq!(presence(&engine, &owner).activity, FileActivity::Viewing);
    assert!(engine
        .snapshot(&owner)
        .unwrap()
        .leases
        .iter()
        .any(|lease| lease.resource_id == format!("file:{LANG}")));
}

#[test]
fn same_subject_windows_have_independent_focus_and_takeover_immediately_demotes_old_editor() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, owner, key) = setup(dir.path());
    let (_, second) = engine.login(&key, "second window", 1001).unwrap();
    engine
        .set_file_presence(&owner, Some(SOURCE.into()), 1002)
        .unwrap();
    engine
        .set_file_presence(&second.id, Some(SOURCE.into()), 1002)
        .unwrap();
    assert_eq!(
        engine.snapshot(&owner).unwrap().session.subject_id,
        second.subject_id
    );
    engine
        .acquire_files(&owner, &[SOURCE.into()], false, 1003)
        .unwrap();
    assert_eq!(presence(&engine, &owner).activity, FileActivity::Editing);
    assert_eq!(
        presence(&engine, &second.id).activity,
        FileActivity::Viewing
    );
    assert_eq!(
        engine
            .acquire_files(&second.id, &[SOURCE.into()], false, 1004)
            .unwrap_err()
            .code,
        "locked"
    );
    engine
        .acquire_files(&second.id, &[SOURCE.into()], true, 1004)
        .unwrap();
    assert_eq!(presence(&engine, &owner).activity, FileActivity::Viewing);
    assert_eq!(
        presence(&engine, &second.id).activity,
        FileActivity::Editing
    );
    engine.set_file_presence(&second.id, None, 1005).unwrap();
    assert_eq!(presence(&engine, &owner).path, SOURCE);
    // Focus is not a lease mutation: the client explicitly chooses which lease IDs to release.
    assert_eq!(engine.snapshot(&owner).unwrap().leases.len(), 1);
}

#[test]
fn viewer_can_announce_focus_but_cannot_claim_editing_and_revocation_removes_presence() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, owner, _) = setup(dir.path());
    let (subject, key) = engine
        .create_subject(&owner, "editor".into(), "automation".into(), Role::Editor)
        .unwrap();
    let (_, editor) = engine.login(&key, "agent", 1001).unwrap();
    engine
        .set_file_presence(&editor.id, Some(SOURCE.into()), 1002)
        .unwrap();
    engine
        .acquire_files(&editor.id, &[SOURCE.into()], false, 1003)
        .unwrap();
    assert_eq!(
        presence(&engine, &editor.id).activity,
        FileActivity::Editing
    );
    engine
        .update_subject(&owner, &subject.id, Role::Viewer, true)
        .unwrap();
    assert_eq!(
        presence(&engine, &editor.id).activity,
        FileActivity::Viewing
    );
    assert_eq!(
        engine
            .acquire_files(&editor.id, &[SOURCE.into()], false, 1004)
            .unwrap_err()
            .code,
        "forbidden"
    );
    engine
        .set_file_presence(&editor.id, Some(LANG.into()), 1004)
        .unwrap();
    assert_eq!(
        presence(&engine, &editor.id).activity,
        FileActivity::Viewing
    );
    engine
        .update_subject(&owner, &subject.id, Role::Viewer, false)
        .unwrap();
    assert!(!engine
        .snapshot(&owner)
        .unwrap()
        .sessions
        .iter()
        .any(|session| session.id == editor.id));
    assert_eq!(
        engine
            .set_file_presence(&editor.id, Some(SOURCE.into()), 1005)
            .unwrap_err()
            .code,
        "unauthorized"
    );
}

#[test]
fn expired_leases_cannot_be_revived_by_late_heartbeat_and_expired_sessions_disappear() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, owner, _) = setup(dir.path());
    engine
        .set_file_presence(&owner, Some(SOURCE.into()), 1000)
        .unwrap();
    let lease = engine
        .acquire_files(&owner, &[SOURCE.into()], false, 1000)
        .unwrap()
        .remove(0);
    engine.heartbeat(&owner, None, None, false, 2000).unwrap();
    engine
        .renew_files(&owner, &[lease.id.clone()], 1000 + LEASE_TTL)
        .unwrap();
    assert_eq!(presence(&engine, &owner).activity, FileActivity::Viewing);
    assert!(engine.snapshot(&owner).unwrap().leases.is_empty());
    assert_eq!(
        engine
            .release(&owner, &lease.resource_id, &lease.id, 1000 + LEASE_TTL)
            .unwrap_err()
            .code,
        "locked"
    );
    engine.expire(2000 + SESSION_TTL);
    assert_eq!(engine.snapshot(&owner).unwrap_err().code, "unauthorized");
}

#[test]
fn snapshots_are_ordered_even_when_only_ephemeral_state_changes() {
    let dir = tempfile::tempdir().unwrap();
    let (mut engine, owner, _) = setup(dir.path());
    let clock_before = now_ms();
    let before = engine.snapshot(&owner).unwrap();
    engine
        .set_file_presence(&owner, Some(SOURCE.into()), 1001)
        .unwrap();
    let focused = engine.snapshot(&owner).unwrap();
    engine
        .acquire_files(&owner, &[SOURCE.into()], false, 1002)
        .unwrap();
    let editing = engine.snapshot(&owner).unwrap();
    let clock_after = now_ms();
    assert_eq!(before.revision, editing.revision);
    assert!(before.status_version < focused.status_version);
    assert!(focused.status_version < editing.status_version);
    assert!(before.server_time >= clock_before);
    assert!(editing.server_time <= clock_after);
}
