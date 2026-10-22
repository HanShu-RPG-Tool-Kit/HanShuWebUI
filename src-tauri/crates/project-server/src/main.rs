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
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
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
