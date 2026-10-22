//! Optional LAN listener over the SAME engine. Shared URLs lead to password login;
//! account creation and Admin sessions remain confined to the trusted local host.
use super::*;
use axum::extract::ConnectInfo;
use std::sync::atomic::{AtomicU64, Ordering};

pub type WebAssetResolver = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;
#[derive(Clone)]
enum Assets {
    Directory(PathBuf),
    Embedded(WebAssetResolver),
}
struct Running {
    urls: Vec<String>,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<std::io::Result<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.task.abort();
    }
}
struct Data {
    running: Option<Running>,
    firewall: String,
    firewall_message: String,
}
pub(super) struct ShareControl {
    root: PathBuf,
    assets: Mutex<Option<Assets>>,
    data: Mutex<Data>,
    generation: AtomicU64,
    next_generation: AtomicU64,
}
impl ShareControl {
    pub(super) fn root(&self) -> &FsPath {
        &self.root
    }
    pub(super) fn web_root(&self) -> Option<PathBuf> {
        self.assets
            .lock()
            .ok()
            .and_then(|assets| match assets.as_ref() {
                Some(Assets::Directory(path)) => Some(path.clone()),
                _ => None,
            })
    }
    pub(super) fn new(root: &FsPath, web_root: Option<&FsPath>) -> Arc<Self> {
        let web = web_root
            .map(FsPath::to_path_buf)
            .or_else(|| std::env::var_os("HANSHU_WEB_ROOT").map(PathBuf::from))
            .or_else(|| std::env::current_dir().ok().map(|path| path.join("dist")))
            .and_then(|path| path.canonicalize().ok())
            .filter(|path| path.join("index.html").is_file());
        Arc::new(Self {
            root: root.to_owned(),
            assets: Mutex::new(web.map(Assets::Directory)),
            data: Mutex::new(Data {
                running: None,
                firewall: "unknown".into(),
                firewall_message: String::new(),
            }),
            generation: AtomicU64::new(0),
            next_generation: AtomicU64::new(1),
        })
    }
    pub(super) fn set_web_assets(&self, resolver: WebAssetResolver) {
        if resolver("/index.html").is_some() {
            if let Ok(mut assets) = self.assets.lock() {
                *assets = Some(Assets::Embedded(resolver));
            }
        }
    }
    pub(super) fn is_active(&self, generation: u64) -> bool {
        generation != 0 && self.generation.load(Ordering::Acquire) == generation
    }
    pub(super) fn shutdown(&self, _engine: &Arc<Mutex<Engine>>) {
        self.generation.store(0, Ordering::Release);
        if let Ok(mut data) = self.data.lock() {
            data.running.take();
        }
    }
}
pub(super) async fn owner(
    state: &AppState,
    headers: &HeaderMap,
) -> std::result::Result<String, ApiError> {
    access(state, bearer(headers)?, false, |engine, sid, _| {
        if engine.role(sid)? != Role::Owner {
            return Err(Error::new("forbidden", "需要工程管理权限"));
        }
        Ok(sid.to_owned())
    })
    .await
}
fn data(control: &ShareControl) -> Result<std::sync::MutexGuard<'_, Data>> {
    control
        .data
        .lock()
        .map_err(|_| Error::new("storage", "共享状态不可用"))
}
fn snapshot_value(state: &AppState, sid: &str) -> Result<Value> {
    let _snapshot = state
        .engine
        .lock()
        .map_err(|_| Error::new("storage", "工程状态不可用"))?
        .snapshot(sid)?;
    let data = data(&state.sharing)?;
    let urls = data
        .running
        .as_ref()
        .map(|running| running.urls.clone())
        .unwrap_or_default();
    Ok(
        json!({"active": data.running.is_some(), "urls": urls, "serverTime": now_ms(),
        "firewall": {"supported": cfg!(windows), "phase": data.firewall, "message": data.firewall_message}}),
    )
}
async fn status(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let sid = owner(&state, &headers).await?;
    let value = tokio::task::spawn_blocking(move || snapshot_value(&state, &sid))
        .await
        .map_err(|_| Error::new("storage", "共享状态读取失败"))??;
    Ok(Json(value))
}
fn lan_address() -> Result<std::net::Ipv4Addr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")?;
    // UDP connect only selects a route; no datagram is sent.
    socket.connect("192.0.2.1:80")?;
    match socket.local_addr()?.ip() {
        std::net::IpAddr::V4(ip)
            if !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() =>
        {
            Ok(ip)
        }
        _ => Err(Error::new(
            "invalid",
            "未找到局域网 IPv4 地址，请先连接网络",
        )),
    }
}
async fn enable(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let sid = owner(&state, &headers).await?;
    if state.sharing.generation.load(Ordering::Acquire) != 0 {
        return Ok(Json(snapshot_value(&state, &sid)?));
    }
    let assets = state
        .sharing
        .assets
        .lock()
        .map_err(|_| Error::new("storage", "网页资源不可用"))?
        .clone()
        .ok_or_else(|| Error::new("invalid", "共享网页资源尚未准备好，请重新启动本机服务"))?;
    if let Assets::Directory(web) = &assets {
        if state
            .sharing
            .root
            .canonicalize()
            .map_err(Error::from)?
            .starts_with(web)
        {
            return Err(Error::new("invalid", "静态网页目录不能包含工程或凭证").into());
        }
    }
    let ip = lan_address()?;
    let port_file = state.sharing.root.join(".hanshu/service/share-port");
    let preferred = std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .unwrap_or(0);
    let listener = match TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, preferred)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind("0.0.0.0:0").await.map_err(Error::from)?,
    };
    let port = listener.local_addr().map_err(Error::from)?.port();
    std::fs::write(&port_file, port.to_string()).map_err(Error::from)?;
    let url = format!("http://{ip}:{port}");
    let mut remote = state.clone();
    remote.origins = Arc::new(vec![
        url.clone(),
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ]);
    let mut data = data(&state.sharing)?;
    if data.running.is_some() {
        drop(data);
        return Ok(Json(snapshot_value(&state, &sid)?));
    }
    let generation = state
        .sharing
        .next_generation
        .fetch_add(1, Ordering::Relaxed);
    remote.share_generation = Some(generation);
    remote.remote_only = true;
    let mut router = super::project_router(None).merge(guest_routes());
    router = match assets {
        Assets::Directory(web) => {
            router.fallback_service(ServeDir::new(web).append_index_html_on_directories(true))
        }
        Assets::Embedded(_) => router.fallback(get(embedded_asset)),
    };
    let app = router
        .with_state(remote.clone())
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(remote, origin_guard));
    let (stop, receiver) = oneshot::channel();
    state
        .sharing
        .generation
        .store(generation, Ordering::Release);
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = receiver.await;
        })
        .await
    });
    data.running = Some(Running {
        urls: vec![url],
        stop: Some(stop),
        task,
    });
    drop(data);
    Ok(Json(snapshot_value(&state, &sid)?))
}
async fn disable(State(state): State<AppState>, headers: HeaderMap) -> ApiResult {
    let sid = owner(&state, &headers).await?;
    let clone = state.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<()> {
        let mut data = data(&clone.sharing)?;
        let mut engine = clone
            .engine
            .lock()
            .map_err(|_| Error::new("storage", "工程状态不可用"))?;
        if engine.role(&sid)? != Role::Owner {
            return Err(Error::new("forbidden", "需要工程管理权限"));
        }
        clone.sharing.generation.store(0, Ordering::Release);
        data.running.take();
        let sessions: Vec<_> = engine
            .snapshot(&sid)?
            .sessions
            .into_iter()
            .filter(|s| s.id != sid && engine.role(&s.id).is_ok_and(|role| role != Role::Owner))
            .map(|s| s.id)
            .collect();
        for session in sessions {
            engine.logout(&session);
        }
        Ok(())
    })
    .await
    .map_err(|_| Error::new("storage", "关闭共享失败"))?;
    let _ = state.events.send(());
    result?;
    let sid = owner(&state, &headers).await?;
    Ok(Json(snapshot_value(&state, &sid)?))
}
async fn info(State(state): State<AppState>) -> ApiResult {
    if state
        .share_generation
        .is_none_or(|generation| !state.sharing.is_active(generation))
    {
        return Err(Error::new("forbidden", "Share unavailable").into());
    }
    Ok(Json(
        json!({"service":"hanshu-project-share","authentication":"password"}),
    ))
}
async fn embedded_asset(State(state): State<AppState>, uri: axum::http::Uri) -> Response {
    let path = if uri.path() == "/" {
        "/index.html"
    } else {
        uri.path()
    };
    if path.contains('%')
        || path.contains('\\')
        || path.split('/').any(|part| part.starts_with('.'))
        || path.starts_with("/api/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let resolver = state
        .sharing
        .assets
        .lock()
        .ok()
        .and_then(|assets| match assets.as_ref() {
            Some(Assets::Embedded(resolver)) => Some(resolver.clone()),
            _ => None,
        });
    match resolver.and_then(|resolver| resolver(path)) {
        Some((bytes, mime)) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn firewall(
    State(state): State<AppState>,
    headers: HeaderMap,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> ApiResult {
    let _ = owner(&state, &headers).await?;
    if !peer.ip().is_loopback() {
        return Err(Error::new("forbidden", "请在本机窗口允许防火墙访问").into());
    }
    if !cfg!(windows) {
        return Err(Error::new("invalid", "请在系统防火墙中允许 HanShu 的局域网访问").into());
    }
    {
        let mut data = data(&state.sharing)?;
        if data.firewall == "prompting" {
            return Ok(Json(json!({"phase":"prompting"})));
        }
        data.firewall = "prompting".into();
        data.firewall_message.clear();
    }
    let control = state.sharing.clone();
    tokio::task::spawn_blocking(move || {
        let result = allow_firewall();
        if let Ok(mut data) = control.data.lock() {
            data.firewall = if result.is_ok() { "allowed" } else { "error" }.into();
            data.firewall_message = result.err().map(|error| error.message).unwrap_or_default();
        }
    });
    Ok(Json(json!({"phase":"prompting"})))
}
#[cfg(windows)]
fn allow_firewall() -> Result<()> {
    use base64::Engine as _;
    use std::os::windows::process::CommandExt;
    let executable = std::env::current_exe()?
        .to_string_lossy()
        .replace('\'', "''");
    let script = format!("$ErrorActionPreference='Stop'; $n='HanShuProject-'+([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{executable}')) -replace '[^a-zA-Z0-9]',''); Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue | Remove-NetFirewallRule; New-NetFirewallRule -Name $n -DisplayName 'HanShu project sharing' -Direction Inbound -Action Allow -Program '{executable}' -Protocol TCP -Profile Private,Domain | Out-Null; exit 0");
    let encode = |script: &str| {
        base64::engine::general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        )
    };
    let elevated = format!("try {{ $p=Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -NonInteractive -EncodedCommand {}'; exit $p.ExitCode }} catch {{ exit 1 }}", encode(&script));
    let status = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &encode(&elevated),
        ])
        .creation_flags(0x08000000)
        .status()?;
    if !status.success() {
        return Err(Error::new(
            "forbidden",
            "系统未允许防火墙调整。可重新确认，或在 Windows 防火墙中允许 HanShu 访问专用网络。",
        ));
    }
    Ok(())
}
#[cfg(not(windows))]
fn allow_firewall() -> Result<()> {
    Err(Error::new("invalid", "请在系统中配置防火墙"))
}
pub(super) fn management_routes() -> Router<AppState> {
    Router::new()
        .route("/api/share/status", get(status))
        .route("/api/share/enable", post(enable))
        .route("/api/share/disable", post(disable))
        .route("/api/share/firewall", post(firewall))
}
fn guest_routes() -> Router<AppState> {
    Router::new().route("/api/share/info", get(info))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn embedded_assets_only_resolve_public_paths() {
        let root =
            std::env::temp_dir().join(format!("hanshu-share-assets-{}", uuid::Uuid::new_v4()));
        let service = start(&root, "127.0.0.1:0".parse().unwrap(), vec![], None)
            .await
            .unwrap();
        // Deliberately permissive resolver: the HTTP adapter itself must exclude private/API paths.
        service.set_share_web_assets(Arc::new(|path| {
            Some((path.as_bytes().to_vec(), "text/plain".into()))
        }));
        for (path, expected) in [
            ("/", StatusCode::OK),
            ("/assets/main.js", StatusCode::OK),
            ("/api/local/bootstrap", StatusCode::NOT_FOUND),
            ("/.hanshu/service/owner-key", StatusCode::NOT_FOUND),
            ("/../.hanshu/service/owner-key", StatusCode::NOT_FOUND),
            ("/%2e%2e/private", StatusCode::NOT_FOUND),
        ] {
            let response =
                embedded_asset(State(service.state.clone()), path.parse().unwrap()).await;
            assert_eq!(response.status(), expected, "{path}");
            if expected == StatusCode::OK {
                assert_eq!(response.headers()[header::CONTENT_TYPE], "text/plain");
                let bytes = axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap();
                assert_eq!(
                    &bytes[..],
                    if path == "/" {
                        b"/index.html"
                    } else {
                        path.as_bytes()
                    }
                );
            }
        }
        service.task.abort();
        drop(service);
        // The path is a uniquely created test directory, never a user-selected project.
        std::fs::remove_dir_all(root).unwrap();
    }
}
