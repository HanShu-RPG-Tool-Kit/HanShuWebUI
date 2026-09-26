//! skin-http: standalone HTTP server exposing the same skin-core domain API
//! to browsers. Binds to 127.0.0.1 by default; use --host/--port to change.

mod routes;

use axum::Router;
use skin_core::imports::ImportManager;
use skin_core::storage::Storage;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub library: Arc<Storage>,
    pub imports: Arc<ImportManager>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "skin_http=info,tower_http=info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    let mut host = "127.0.0.1".to_string();
    let mut port = 23891u16;
    let mut data_dir = PathBuf::from("skin-manager-data");
    let mut static_dir: Option<PathBuf> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--host" if i + 1 < args.len() => {
                host = args[i + 1].clone();
                i += 2;
            }
            "--port" if i + 1 < args.len() => {
                port = args[i + 1].parse()?;
                i += 2;
            }
            "--data-dir" if i + 1 < args.len() => {
                data_dir = PathBuf::from(&args[i + 1]);
                i += 2;
            }
            "--static-dir" if i + 1 < args.len() => {
                static_dir = Some(PathBuf::from(&args[i + 1]));
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    std::fs::create_dir_all(&data_dir)?;
    // Process-level library lock: one owner per data directory. The desktop
    // app and a standalone server must not both open the same library.
    // fs4's own FileExt::try_lock (flock) — not the std 1.89 method clippy
    // sometimes mistakes it for.
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("library.lock"))?;
    #[allow(clippy::incompatible_msrv)]
    lock_file
        .try_lock()
        .map_err(|e| {
            format!(
                "library at {} is already in use by another process ({e}); \
                 stop the other owner (desktop app or skin-http) first",
                data_dir.display()
            )
        })?;

    let storage = Arc::new(Storage::open(&data_dir)?);
    // The core crate never creates its own runtime; as a standalone service we
    // install a spawner on our own Tokio runtime (mirrors the Tauri adapter).
    skin_core::imports::set_spawn_hook(|fut| {
        tokio::spawn(fut);
    });
    let imports = Arc::new(ImportManager::new(storage.clone()));
    let state = AppState {
        library: storage,
        imports,
    };

    let api = Router::new()
        .nest("/api/skin/v1", routes::build_router(state))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let app = match static_dir {
        Some(dir) => {
            let index_file = dir.join("index.html");
            let serve_dir = tower_http::services::ServeDir::new(&dir)
                .append_index_html_on_directories(true)
                .not_found_service(tower_http::services::ServeFile::new(index_file));
            api.fallback_service(serve_dir)
        }
        None => api,
    };

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    tracing::info!("skin-http listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
