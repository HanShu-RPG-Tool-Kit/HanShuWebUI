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
        Session::decl(&config),
        Lease::decl(&config),
        Member::decl(&config),
        Snapshot::decl(&config),
    ] {
        println!("export {declaration}\n");
    }
}
