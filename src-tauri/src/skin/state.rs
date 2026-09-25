//! Skin state: initializes the core service into Tauri managed state.
//! Library mutations run on blocking workers (std Mutex + disk IO);
//! network/PNG prep stays outside the library transaction.

use skin_core::imports::ImportManager;
use skin_core::Storage;
use std::sync::Arc;
use tauri::Manager;

pub struct SkinState {
    pub service: Arc<SkinService>,
}

pub struct SkinService {
    pub library: Arc<Storage>,
    pub imports: Arc<ImportManager>,
}

impl SkinState {
    /// Open (or create) the skin library under the app's local data dir.
    pub fn init(app: &tauri::AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("app_local_data_dir unavailable: {e}"))?
            .join("skin-manager");
        let library = Arc::new(Storage::open(&root).map_err(|e| e.to_string())?);
        let imports = Arc::new(ImportManager::new(library.clone()));
        // Core jobs spawn through the Tauri async runtime — never a second one.
        skin_core::imports::set_spawn_hook(|fut| {
            tauri::async_runtime::spawn(fut);
        });
        Ok(Self { service: Arc::new(SkinService { library, imports }) })
    }
}
