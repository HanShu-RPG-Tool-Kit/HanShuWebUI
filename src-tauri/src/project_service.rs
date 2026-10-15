//! Desktop host only: the project service itself has no Tauri dependency.
use project_server::{LocalConnection, Service};
use std::sync::Mutex;
use tauri::Manager;

pub struct ProjectService {
    connection: LocalConnection,
    _service: Mutex<Service>,
}
impl ProjectService {
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("project-service");
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
        let credential =
            std::fs::read_to_string(root.join("owner-key")).map_err(|e| e.to_string())?;
        Ok(Self {
            connection: LocalConnection {
                url: format!("http://127.0.0.1:{}", service.address.port()),
                credential,
            },
            _service: Mutex::new(service),
        })
    }
}

/// Local desktop IPC only. The network server never exposes the bootstrap credential.
#[tauri::command]
pub fn project_local_connection(state: tauri::State<'_, ProjectService>) -> LocalConnection {
    state.connection.clone()
}
