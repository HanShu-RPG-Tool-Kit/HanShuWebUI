use project_core::*;
use ts_rs::TS;

fn main() {
    let config = ts_rs::Config::default();
    println!("// Generated from project-core. Run npm run generate:protocol; do not edit.\n");
    for declaration in [
        Role::decl(&config),
        Subject::decl(&config),
        ResourceKind::decl(&config),
        ResourceInfo::decl(&config),
        Resource::decl(&config),
        FileActivity::decl(&config),
        FilePresence::decl(&config),
        Session::decl(&config),
        Lease::decl(&config),
        Member::decl(&config),
        Snapshot::decl(&config),
        ProjectFile::decl(&config),
        ProjectFileTree::decl(&config),
        FileChange::decl(&config),
        FileTransactionStatus::decl(&config),
        FileTransactionError::decl(&config),
        FileTransactionReceipt::decl(&config),
        SourceFileMove::decl(&config),
    ] {
        // ts-rs inserts spaces before documentation newlines; keep generated files clean.
        let declaration = declaration
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n");
        println!("export {declaration}\n");
    }
}
