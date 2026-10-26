//! Offline diagnosis must never open, recover or mutate the project.
use std::{fs, process::Command};

fn inspect(root: &std::path::Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_project-server"))
        .arg("--project")
        .arg(root)
        .arg("--archive-check")
        .output()
        .unwrap()
}

#[test]
fn empty_project_inspection_does_not_create_service_state() {
    let directory = tempfile::tempdir().unwrap();
    let output = inspect(directory.path());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["stats"]["archiveCount"], 0);
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn corrupt_receipt_reports_exit_two_and_preserves_exact_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory
        .path()
        .join(".hanshu/service/file-transactions/archive/aa");
    fs::create_dir_all(&archive).unwrap();
    let receipt = archive.join(format!("{}.json.gz", "a".repeat(64)));
    let bytes = b"this is not gzip";
    fs::write(&receipt, bytes).unwrap();
    let output = inspect(directory.path());
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["stats"]["corruptCount"], 1);
    assert_eq!(report["entries"][0]["status"], "corrupt");
    assert!(report["entries"][0]["relativePath"]
        .as_str()
        .unwrap()
        .ends_with(".json.gz"));
    assert_eq!(fs::read(receipt).unwrap(), bytes);
    assert!(!directory
        .path()
        .join(".hanshu/service/file-transactions/archive-quarantine")
        .exists());
    assert!(!directory
        .path()
        .join(".hanshu/service/service.lock")
        .exists());
}
