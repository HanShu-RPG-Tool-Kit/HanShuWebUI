//! Shared standalone / embedded server. No desktop APIs or client-side trust decisions.
mod local_projects;
mod accounts;
pub use local_projects::create_project_directory;
mod sharing;
pub use sharing::WebAssetResolver;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use project_core::{now_ms, Engine, Error, FileActivity, Result, Role};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, oneshot},
    task::JoinHandle,
};
use tower_http::services::ServeDir;

#[derive(Clone)]
struct AppState {
    engine: Arc<Mutex<Engine>>,
    events: broadcast::Sender<()>,
    origins: Arc<Vec<String>>,
    sharing: Arc<sharing::ShareControl>,
    share_generation: Option<u64>,
    remote_only: bool,
    accounts: Arc<Mutex<accounts::Accounts>>,
    login_slots: Arc<tokio::sync::Semaphore>,
}

#[derive(Debug)]
struct ApiError(Error);
impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0.code {
            "unauthorized" => StatusCode::UNAUTHORIZED,
            "forbidden" => StatusCode::FORBIDDEN,
            "not_found" => StatusCode::NOT_FOUND,
            "locked" => StatusCode::LOCKED,
            "conflict" => StatusCode::CONFLICT,
            "storage" => StatusCode::INTERNAL_SERVER_ERROR,
            "busy" => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::BAD_REQUEST,
        };
        (status, Json(self.0)).into_response()
    }
}
type ApiResult = std::result::Result<Json<Value>, ApiError>;
fn bearer(headers: &HeaderMap) -> std::result::Result<String, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| Error::new("unauthorized", "需要登录会话").into())
}
async fn access<T: Send + 'static>(
    state: &AppState,
    token: String,
    changed: bool,
    f: impl FnOnce(&mut Engine, &str, u64) -> Result<T> + Send + 'static,
) -> std::result::Result<T, ApiError> {
    let engine = state.engine.clone();
    let accounts = state.accounts.clone();
    let remote = state.remote_only || state.share_generation.is_some();
    let result = tokio::task::spawn_blocking(move || {
        let mut accounts = accounts.lock().map_err(|_|Error::new("storage","账号服务不可用"))?;
        let mut e = engine
            .lock()
            .map_err(|_| Error::new("storage", "服务状态不可用"))?;
        let now = now_ms();
        let sid = e.authenticate(&token, now)?;
        accounts.validate_session(&mut e, &sid, now, remote)?;
        f(&mut e, &sid, now)
    })
    .await
    .map_err(|_| Error::new("storage", "服务任务失败"))??;
    if changed {
        let _ = state.events.send(());
    }
    Ok(result)
}

async fn origin_guard(
    State(state): State<AppState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let local = !state.remote_only && state.share_generation.is_none() && local_projects::trusted_local(&request);
    if !local {
        if let Ok(token)=bearer(request.headers()) {
            if let Ok(mut engine)=state.engine.lock() {
                if engine.authenticate(&token,now_ms()).ok().is_some_and(|sid|matches!(engine.role(&sid),Ok(Role::Owner))) {
                    return ApiError(Error::new("forbidden","Admin 只允许本机操作")).into_response();
                }
            }
        }
    }
    if state.share_generation.is_some_and(|generation| !state.sharing.is_active(generation)) {
        return ApiError(Error::new("forbidden", "工程共享已关闭")).into_response();
    }
    let origin = request.headers().get(header::ORIGIN).cloned();
    if let Some(origin) = &origin {
        if !origin
            .to_str()
            .ok()
            .is_some_and(|o| state.origins.iter().any(|s| s == o))
        {
            return ApiError(Error::new("forbidden", "此客户端来源未获服务允许")).into_response();
        }
    }
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("Authorization, Content-Type"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    credential: String,
    client_name: String,
}
async fn local_login(State(state): State<AppState>, Json(input): Json<Login>) -> ApiResult {
    if state.remote_only || state.share_generation.is_some() {return Err(Error::new("forbidden","Admin 只允许本机登录").into())}
    if input.credential.len() > 128 {
        return Err(Error::new("unauthorized", "访问凭证无效").into());
    }
    let engine = state.engine.clone();
    let (token, session) = tokio::task::spawn_blocking(move || {
        engine
            .lock()
            .map_err(|_| Error::new("storage", "服务状态不可用"))?
            .login(&input.credential, &input.client_name, now_ms())
    })
    .await
    .map_err(|_| Error::new("storage", "登录任务失败"))??;
    let _ = state.events.send(());
    Ok(Json(json!({"token":token,"session":session})))
}
async fn snapshot(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let v = access(&s, bearer(&h)?, false, |e, id, _| e.snapshot(id)).await?;
    Ok(Json(json!(v)))
}
async fn logout(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let token = bearer(&h)?;
    // The core logout revokes the session and all its leases.
    let sid=access(&s, token, true, |e, id, _| {
        e.logout(id);
        Ok(id.to_owned())
    })
    .await?;
    accounts::lock(&s)?.revoke_session(&sid);
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Heartbeat {
    #[serde(default)]
    file_leases: Vec<String>,
    resource_id: Option<String>,
    lease_id: Option<String>,
    #[serde(default)]
    typing: bool,
}
async fn heartbeat(State(s): State<AppState>, h: HeaderMap, Json(i): Json<Heartbeat>) -> ApiResult {
    let v = access(&s, bearer(&h)?, true, move |e, id, now| {
        e.heartbeat(id, i.resource_id, i.lease_id.as_deref(), i.typing, now)?;
        // A role downgrade must not break presence heartbeats sent with old lease IDs.
        if !i.file_leases.is_empty() && e.role(id)?.can_write() {
            e.renew_files(id, &i.file_leases, now)?;
        }
        e.snapshot(id)
    })
    .await?;
    Ok(Json(json!(v)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Presence {
    path: Option<String>,
    entry_id: Option<String>,
    activity: Option<FileActivity>,
}
async fn presence(State(s): State<AppState>, h: HeaderMap, Json(i): Json<Presence>) -> ApiResult {
    let snapshot = access(&s, bearer(&h)?, true, move |e, id, now| {
        e.set_file_presence(
            id,
            i.path,
            i.entry_id,
            i.activity.unwrap_or(FileActivity::Viewing),
            now,
        )?;
        e.snapshot(id)
    })
    .await?;
    Ok(Json(json!(snapshot)))
}
async fn events(State(mut state): State<AppState>, axum::extract::ConnectInfo(peer):axum::extract::ConnectInfo<SocketAddr>, h:HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !peer.ip().is_loopback() || !local_projects::local_headers(&h) {state.remote_only=true;}
    ws.max_message_size(1024)
        .on_upgrade(move |socket| watch(socket, state))
}

async fn files(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    let v = access(&s, bearer(&h)?, false, |e, id, _| e.files_snapshot(id)).await?;
    Ok(Json(json!(v)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryQuery { before: Option<u64>, limit: Option<usize>, path: Option<String> }
async fn history_list(State(s): State<AppState>, h: HeaderMap, Query(i): Query<HistoryQuery>) -> ApiResult {
    Ok(Json(json!(access(&s, bearer(&h)?, false, move |e, id, _| e.history_list(id, i.before, i.limit.unwrap_or(60), i.path.as_deref())).await?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryTreeQuery { path: Option<String> }
async fn history_tree(State(s): State<AppState>, h: HeaderMap, Path(sequence): Path<u64>, Query(i): Query<HistoryTreeQuery>) -> ApiResult {
    Ok(Json(json!(access(&s, bearer(&h)?, false, move |e, id, _| e.history_tree_scoped(id, sequence, i.path.as_deref())).await?)))
}
async fn history_content(State(s): State<AppState>, h: HeaderMap, Path(sequence): Path<u64>, Query(i): Query<FileRelations>) -> ApiResult {
    Ok(Json(json!(access(&s, bearer(&h)?, false, move |e, id, _| e.history_content(id, sequence, &i.path)).await?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryLabel { label: Option<String> }
async fn history_label(State(s): State<AppState>, h: HeaderMap, Path(sequence): Path<u64>, Json(i): Json<HistoryLabel>) -> ApiResult {
    Ok(Json(json!(access(&s, bearer(&h)?, true, move |e, id, now| e.history_label(id, sequence, i.label, now)).await?)))
}
async fn history_stats(State(s): State<AppState>, h: HeaderMap) -> ApiResult {
    Ok(Json(json!(access(&s, bearer(&h)?, false, |e, id, _| e.history_stats(id)).await?)))
}
async fn history_restore_plan(State(s): State<AppState>, h: HeaderMap, Json(i): Json<project_core::HistoryRestoreSelection>) -> ApiResult {
    Ok(Json(json!(access(&s, bearer(&h)?, false, move |e, id, _| e.plan_history_restore(id, i)).await?)))
}
#[derive(Deserialize)]
struct FileRead {
    path: String,
    version: Option<String>,
}
async fn file_read(
    State(s): State<AppState>,
    h: HeaderMap,
    Query(i): Query<FileRead>,
) -> ApiResult {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let (bytes, version) = access(&s, bearer(&h)?, false, move |e, id, _| {
        e.read_project_file(id, &i.path, i.version.as_deref())
    })
    .await?;
    Ok(Json(
        json!({"content": STANDARD.encode(bytes), "version": version}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRelations {
    path: String,
}
async fn file_relations(
    State(s): State<AppState>,
    h: HeaderMap,
    Query(i): Query<FileRelations>,
) -> ApiResult {
    let relations = access(&s, bearer(&h)?, false, move |e, id, _| {
        e.resource_relations(id, &i.path)
    })
    .await?;
    Ok(Json(json!(relations)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilePlan {
    operations: Vec<project_core::FileOperationRequest>,
}
async fn file_plan(State(s): State<AppState>, h: HeaderMap, Json(i): Json<FilePlan>) -> ApiResult {
    let plan = access(&s, bearer(&h)?, false, move |e, id, _| {
        e.plan_file_operations(id, &i.operations)
    })
    .await?;
    Ok(Json(json!(plan)))
}
#[derive(Deserialize)]
struct FileLeases {
    paths: Vec<String>,
    #[serde(default)]
    force: bool,
}
async fn file_leases(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(i): Json<FileLeases>,
) -> ApiResult {
    let leases = access(&s, bearer(&h)?, true, move |e, id, now| {
        e.acquire_files(id, &i.paths, i.force, now)
    })
    .await?;
    Ok(Json(json!(leases)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileBatch {
    transaction_id: String,
    changes: Vec<project_core::FileChange>,
}
async fn file_commit(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(i): Json<FileBatch>,
) -> ApiResult {
    let files = access(&s, bearer(&h)?, true, move |e, id, now| {
        e.commit_files(id, &i.transaction_id, i.changes, now)
    })
    .await?;
    Ok(Json(json!(files)))
}
async fn file_transaction(
    State(s): State<AppState>,
    h: HeaderMap,
    Path(transaction_id): Path<String>,
) -> ApiResult {
    let receipt = access(&s, bearer(&h)?, false, move |e, id, _| {
        e.file_transaction(id, &transaction_id)
    })
    .await?;
    Ok(Json(json!(receipt)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRelease {
    path: String,
    lease_id: String,
}
async fn file_release(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(i): Json<FileRelease>,
) -> ApiResult {
    access(&s, bearer(&h)?, true, move |e, id, now| {
        e.release(id, &format!("file:{}", i.path), &i.lease_id, now)
    })
    .await?;
    Ok(Json(json!({"ok":true})))
}
async fn watch(mut socket: WebSocket, state: AppState) {
    // Browser WebSocket cannot attach an Authorization header. Authenticate in the first frame,
    // never in a URL that can be logged or retained in browser history.
    let Ok(Some(Ok(Message::Text(first)))) =
        tokio::time::timeout(std::time::Duration::from_secs(5), socket.recv()).await
    else {
        return;
    };
    let token = serde_json::from_str::<Value>(&first)
        .ok()
        .and_then(|v| v["token"].as_str().map(str::to_owned))
        .filter(|s| s.len() <= 128);
    let Some(token) = token else { return };
    let mut updates = state.events.subscribe();
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        if state.share_generation.is_some_and(|generation| !state.sharing.is_active(generation)) {
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
        let result = access(&state, token.clone(), false, |e, id, _| e.snapshot(id)).await;
        let Ok(snapshot) = result else {
            let _ = socket.send(Message::Close(None)).await;
            return;
        };
        if socket
            .send(Message::Text(
                json!({"type":"snapshot","data":snapshot})
                    .to_string()
                    .into(),
            ))
            .await
            .is_err()
        {
            return;
        }
        tokio::select! {
            _=updates.recv()=>{},
            _=interval.tick()=>{},
            message=socket.recv()=>{match message {Some(Ok(Message::Ping(v)))=>{if socket.send(Message::Pong(v)).await.is_err(){return;}},Some(Ok(Message::Pong(_)))=>{},_=>return}}
        }
    }
}

pub struct Service {
    pub address: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    pub task: JoinHandle<std::io::Result<()>>,
    state: AppState,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.state.sharing.shutdown(&self.state.engine);
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}
impl Service {
    pub fn local_connection(&self, name:&str)->Result<LocalConnection> {
        let root = self.state.sharing.root();
        let key=std::fs::read_to_string(root.join(".hanshu/service/owner-key"))?;
        let (token,_)=self.state.engine.lock().map_err(|_|Error::new("storage","工程状态不可用"))?.login(key.trim(),name,now_ms())?;
        Ok(LocalConnection{
            url:format!("http://127.0.0.1:{}",self.address.port()),
            token,
            path: local_projects::display_path(root),
        })
    }
    pub fn set_share_web_assets(&self, resolver: WebAssetResolver) {
        self.state.sharing.set_web_assets(resolver);
    }
    pub async fn open_project(&self,root:&FsPath,address:SocketAddr,origins:Vec<String>,web:Option<PathBuf>)->Result<Service> {
        start_inner(root,address,origins,web,false,Some(self.state.accounts.clone())).await
    }
}

pub async fn start(
    root: &FsPath,
    address: SocketAddr,
    origins: Vec<String>,
    web_root: Option<PathBuf>,
) -> Result<Service> {
    start_inner(root, address, origins, web_root, false, None).await
}

/// Explicit local host mode. Never enabled for a network project server.
pub async fn start_local(
    root: &FsPath,
    address: SocketAddr,
    origins: Vec<String>,
    web_root: Option<PathBuf>,
) -> Result<Service> {
    if !address.ip().is_loopback() {
        return Err(Error::new("invalid", "本机工程入口只允许监听回环地址"));
    }
    start_inner(root, address, origins, web_root, true, None).await
}

fn project_router(web_root: Option<PathBuf>) -> Router<AppState> {
    let mut router = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"service":"hanshu-project","protocol":11})) }),
        )
        .route("/api/sessions", post(accounts::login).layer(DefaultBodyLimit::max(4096)))
        .route("/api/local-session",post(local_login).layer(DefaultBodyLimit::max(4096)).layer(middleware::from_fn(local_projects::local_only)))
        .route("/api/sessions/current", axum::routing::delete(logout))
        .route("/api/project", get(snapshot))
        .route("/api/history", get(history_list))
        .route("/api/history/stats", get(history_stats))
        .route("/api/history/{sequence}/tree", get(history_tree))
        .route("/api/history/{sequence}/content", get(history_content))
        .route("/api/history/{sequence}/label", post(history_label))
        .route("/api/history/restore-plan", post(history_restore_plan).layer(DefaultBodyLimit::max(256 * 1024)))
        .route("/api/files", get(files))
        .route("/api/files/content", get(file_read))
        .route("/api/files/relations", get(file_relations))
        .route(
            "/api/files/plan",
            post(file_plan).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route(
            "/api/files/transactions/{transaction_id}",
            get(file_transaction),
        )
        .route("/api/files/leases", post(file_leases).delete(file_release))
        .route(
            "/api/files/commit",
            post(file_commit).layer(DefaultBodyLimit::max(48 * 1024 * 1024)),
        )
        .route("/api/heartbeat", post(heartbeat))
        .route("/api/presence", post(presence))
        .route("/api/events", get(events));
    if let Some(root) = web_root {
        router =
            router.fallback_service(ServeDir::new(root).append_index_html_on_directories(true));
    }
    router.merge(sharing::management_routes()).merge(accounts::management_routes())
}

async fn start_inner(
    root: &FsPath,
    address: SocketAddr,
    mut origins: Vec<String>,
    web_root: Option<PathBuf>,
    local_projects: bool,
    accounts: Option<Arc<Mutex<accounts::Accounts>>>,
) -> Result<Service> {
    if let Some(web) = &web_root {
        std::fs::create_dir_all(root)?;
        let project_path = root.canonicalize()?;
        let web_path = web.canonicalize()?;
        if project_path.starts_with(&web_path) {
            return Err(Error::new(
                "invalid",
                "静态网页目录不能包含工程服务的数据或凭证目录",
            ));
        }
    }
    let engine = Engine::open_project(root)?;
    let listener = TcpListener::bind(address).await?;
    let address = listener.local_addr()?;
    origins.extend([
        format!("http://{address}"),
        format!("http://localhost:{}", address.port()),
        "tauri://localhost".into(),
        "http://tauri.localhost".into(),
        "https://tauri.localhost".into(),
    ]);
    let state = AppState {
        engine: Arc::new(Mutex::new(engine)),
        events: broadcast::channel(128).0,
        origins: Arc::new(origins.clone()),
        sharing: sharing::ShareControl::new(root, web_root.as_deref()),
        share_generation: None,
        remote_only: false,
        accounts: match accounts {Some(accounts)=>accounts,None=>accounts::Accounts::open(root)?},
        login_slots: Arc::new(tokio::sync::Semaphore::new(8)),
    };
    let local_host = if local_projects {
        Some(local_projects::LocalHost::new(
            root,
            address,
            origins.clone(),
            web_root.as_deref(),
            state.clone(),
        )?)
    } else {
        None
    };
    let router = project_router(web_root);
    let mut app = router.with_state(state.clone());
    if let Some(host) = local_host {
        app = app.merge(local_projects::router(host));
    }
    let app = app
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), origin_guard));
    let (stop, receiver) = oneshot::channel();
    let task = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async {
                let _ = receiver.await;
            })
            .await
    });
    Ok(Service {
        address,
        stop: Some(stop),
        task,
        state,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConnection {
    pub url: String,
    pub token: String,
    pub path: String,
}
