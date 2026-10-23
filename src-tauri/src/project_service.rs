//! Desktop host only: the project service itself has no Tauri dependency.
use project_server::{LocalConnection, Service};
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub struct ProjectService {
    _service: tokio::sync::Mutex<Service>,
}
fn share_assets(service: &Service, app: &tauri::AppHandle) {
    let resolver = app.asset_resolver();
    service.set_share_web_assets(Arc::new(move |path| {
        resolver
            .get(path.to_owned())
            .map(|asset| (asset.bytes, asset.mime_type))
    }));
}
impl ProjectService {
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("projects/default");
        let address = std::env::var("HANSHU_PROJECT_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:0".into())
            .parse()
            .map_err(|_| "HANSHU_PROJECT_LISTEN 地址无效")?;
        let mut origins = vec![
            "http://localhost:5173".into(),
            "http://127.0.0.1:5173".into(),
        ];
        if let Ok(extra) = std::env::var("HANSHU_PROJECT_ORIGINS") {
            origins.extend(
                extra
                    .split(',')
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.trim().to_owned()),
            );
        }
        let service =
            tauri::async_runtime::block_on(project_server::start(&root, address, origins, None))
                .map_err(|e| e.to_string())?;
        share_assets(&service, app);
        Ok(Self {
            _service: tokio::sync::Mutex::new(service),
        })
    }
}

/// Local desktop IPC only. The network server never exposes the bootstrap credential.
#[tauri::command]
pub async fn project_local_connection(
    state: tauri::State<'_, ProjectService>,
) -> Result<LocalConnection, String> {
    state
        ._service
        .lock()
        .await
        .local_connection("Desktop")
        .map_err(|e| e.to_string())
}

/// Trusted desktop host: pick a folder, or reopen a path the user previously opened.
/// Network-facing local APIs still only accept temporary directory IDs.
#[tauri::command]
pub async fn project_open_local(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectService>,
    name: Option<String>,
    path: Option<String>,
) -> Result<LocalConnection, String> {
    let root = if let Some(path) = path {
        if name.is_some() {
            return Err("重新打开最近工程时不能同时创建工程".into());
        }
        let root = std::path::PathBuf::from(path);
        let root = root.canonicalize().map_err(|_| "工程目录已不存在，请重新浏览选择".to_string())?;
        if !root.is_dir() {
            return Err("工程目录已不存在，请重新浏览选择".into());
        }
        root
    } else {
        let chooser = app.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            chooser
                .dialog()
                .file()
                .set_title("由本机服务打开工程目录")
                .blocking_pick_folder()
        })
        .await
        .map_err(|e| e.to_string())?
        .ok_or("已取消打开工程")?;
        let parent = selected.into_path().map_err(|e| e.to_string())?;
        if let Some(name) = name {
            project_server::create_project_directory(&parent, &name).map_err(|e| e.to_string())?
        } else {
            parent
        }
    };
    let mut running = state._service.lock().await;
    let service = running
        .open_project(
            &root,
            "127.0.0.1:0".parse().unwrap(),
            vec![
                "http://localhost:5173".into(),
                "http://127.0.0.1:5173".into(),
            ],
            None,
        )
        .await
        .map_err(|e| e.to_string())?;
    share_assets(&service, &app);
    let connection = service
        .local_connection("Desktop")
        .map_err(|e| e.to_string())?;
    *running = service;
    Ok(connection)
}
