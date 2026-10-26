use std::{net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut root = PathBuf::from(".hanshu-project");
    let mut listen: SocketAddr = "127.0.0.1:47831".parse()?;
    let mut origins = vec![
        "http://localhost:5173".into(),
        "http://127.0.0.1:5173".into(),
        "http://localhost:4173".into(),
        "http://127.0.0.1:4173".into(),
    ];
    let mut web = None;
    let mut local_projects = false;
    let mut archive_check = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--archive-check" {
            archive_check = true;
            continue;
        }
        let value = args.next().ok_or("每个参数都需要一个值")?;
        match arg.as_str() {
            "--project" => root = value.into(),
            "--listen" => listen = value.parse()?,
            "--origin" => origins.push(value),
            "--web-root" => web = Some(PathBuf::from(value)),
            "--local-projects" => local_projects = value.parse()?,
            _ => return Err(format!("未知参数：{arg}").into()),
        }
    }
    if archive_check {
        // Offline inspection never opens Engine: no recovery, quarantine or service
        // lock changes, even when corrupt storage prevents normal project opening.
        let report = project_core::inspect_transaction_archives(&root)?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        let stats = &report.stats;
        if stats.corrupt_count
            + stats.quarantined_count
            + stats.protected_count
            + stats.unsafe_count
            + stats.io_error_count
            > 0
        {
            std::process::exit(2);
        }
        return Ok(());
    }
    let service = if local_projects {
        project_server::start_local(&root, listen, origins, web).await?
    } else {
        project_server::start(&root, listen, origins, web).await?
    };
    println!("HanShu S: http://{}", service.address);
    println!(
        "管理者凭证文件：{}",
        root.join(".hanshu/service/owner-key").display()
    );
    tokio::signal::ctrl_c().await?;
    drop(service);
    Ok(())
}
