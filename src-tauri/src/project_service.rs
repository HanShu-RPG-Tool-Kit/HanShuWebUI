//! Desktop host only: the project service itself has no Tauri dependency.
use project_server::{LocalConnection, Service};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub struct ProjectService {
    connection: Mutex<LocalConnection>,
    _service: Mutex<Service>,
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
        let credential = std::fs::read_to_string(root.join(".hanshu/service/owner-key"))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connection: Mutex::new(LocalConnection {
                url: format!("http://127.0.0.1:{}", service.address.port()),
                credential,
            }),
            _service: Mutex::new(service),
        })
    }
}

/// Local desktop IPC only. The network server never exposes the bootstrap credential.
#[tauri::command]
pub fn project_local_connection(
    state: tauri::State<'_, ProjectService>,
) -> Result<LocalConnection, String> {
    Ok(state
        .connection
        .lock()
        .map_err(|_| "工程状态不可用")?
        .clone())
}

/// The trusted native host chooses the directory. C cannot pass a path or obtain a writable handle.
#[tauri::command]
pub async fn project_open_local(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectService>,
    name: Option<String>,
) -> Result<LocalConnection, String> {
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
    let root = if let Some(name) = name {
        project_server::create_project_directory(&parent, &name).map_err(|e| e.to_string())?
    } else {
        parent
    };
    let service = project_server::start(
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
    let credential = std::fs::read_to_string(root.join(".hanshu/service/owner-key"))
        .map_err(|e| e.to_string())?;
    let connection = LocalConnection {
        url: format!("http://127.0.0.1:{}", service.address.port()),
        credential,
    };
    *state.connection.lock().map_err(|_| "工程状态不可用")? = connection.clone();
    *state._service.lock().map_err(|_| "工程状态不可用")? = service;
    Ok(connection)
}
