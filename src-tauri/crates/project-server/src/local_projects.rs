//! Loopback-only host capabilities. Directory selection never gives C a filesystem handle.
//! Project editing continues through the ordinary authenticated project service.
use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Directory {
    id: String,
    name: String,
    path: String,
}
struct HostedProject {
    url: String,
    state: AppState,
    _service: Option<Service>,
}
struct HostData {
    directories: BTreeMap<String, PathBuf>,
    ids: BTreeMap<PathBuf, String>,
    projects: BTreeMap<PathBuf, HostedProject>,
}
pub(super) struct LocalHost {
    token: String,
    data: tokio::sync::Mutex<HostData>,
    roots: Vec<Directory>,
    origins: Vec<String>,
    web_root: Option<PathBuf>,
    accounts: Arc<Mutex<accounts::Accounts>>,
}
impl HostData {
    fn directory(&mut self, path: &FsPath, name: Option<&str>) -> Result<Directory> {
        let path = path.canonicalize()?;
        if !path.is_dir() {
            return Err(Error::new("not_found", "目录已不存在"));
        }
        let id = if let Some(id) = self.ids.get(&path) {
            id.clone()
        } else {
            if self.ids.len() >= 32768 {
                return Err(Error::new("busy", "目录选择记录过多，请重启本机服务后重试"));
            }
            let id = uuid::Uuid::new_v4().to_string();
            self.ids.insert(path.clone(), id.clone());
            self.directories.insert(id.clone(), path.clone());
            id
        };
        Ok(Directory {
            id,
            name: name.map(str::to_owned).unwrap_or_else(|| {
                path.file_name()
                    .unwrap_or(path.as_os_str())
                    .to_string_lossy()
                    .into_owned()
            }),
            path: display_path(&path),
        })
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        let path = self
            .directories
            .get(id)
            .ok_or_else(|| Error::new("not_found", "目录选择已失效，请重新选择"))?;
        let current = path.canonicalize().map_err(directory_error)?;
        if current != *path || !current.is_dir() {
            return Err(Error::new("conflict", "目录已发生变化，请重新选择"));
        }
        Ok(current)
    }
}
fn directory_error(error: std::io::Error) -> Error {
    match error.kind() {
        std::io::ErrorKind::NotFound => Error::new("not_found", "目录已不存在，请重新选择"),
        std::io::ErrorKind::PermissionDenied => {
            Error::new("forbidden", "没有访问此目录的权限，请选择其他目录")
        }
        _ => Error::new("storage", "无法读取这个目录，请重新选择"),
    }
}
fn display_path(path: &FsPath) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(path) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{path}");
        }
        if let Some(path) = value.strip_prefix(r"\\?\") {
            return path.to_owned();
        }
    }
    value.into_owned()
}
impl LocalHost {
    pub(super) fn new(
        root: &FsPath,
        address: SocketAddr,
        origins: Vec<String>,
        web: Option<&FsPath>,
        state: AppState,
    ) -> Result<Arc<Self>> {
        let accounts = state.accounts.clone();
        let root = root.canonicalize()?;
        let mut data = HostData {
            directories: BTreeMap::new(),
            ids: BTreeMap::new(),
            projects: BTreeMap::new(),
        };
        let mut roots = Vec::new();
        let mut add = |path: PathBuf, name: &str| {
            if let Ok(dir) = data.directory(&path, Some(name)) {
                if !roots.iter().any(|item: &Directory| item.id == dir.id) {
                    roots.push(dir);
                }
            }
        };
        add(root.clone(), "默认工程");
        if let Some(parent) = root.parent() {
            add(parent.to_owned(), "工程所在目录");
        }
        let home =
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
        if let Some(home) = home {
            add(home.join("Desktop"), "桌面");
            add(home.join("Documents"), "文档");
            add(home, "个人目录");
        }
        #[cfg(windows)]
        for drive in b'A'..=b'Z' {
            let path = PathBuf::from(format!("{}:\\", drive as char));
            if path.is_dir() {
                add(path, &format!("{}:", drive as char));
            }
        }
        #[cfg(not(windows))]
        add(PathBuf::from("/"), "文件系统");
        let web_root = web
            .map(FsPath::canonicalize)
            .transpose()?
            .or_else(|| state.sharing.web_root());
        data.projects.insert(
            root,
            HostedProject {
                url: format!("http://{address}"),
                state,
                _service: None,
            },
        );
        Ok(Arc::new(Self {
            token: uuid::Uuid::new_v4().to_string(),
            data: tokio::sync::Mutex::new(data),
            roots,
            origins,
            web_root,
            accounts,
        }))
    }
    fn authenticate(&self, headers: &HeaderMap) -> Result<()> {
        if bearer(headers).map_err(|error| error.0)? != self.token {
            return Err(Error::new(
                "unauthorized",
                "本机目录选择已失效，请重新打开工程窗口",
            ));
        }
        Ok(())
    }
}
fn loopback_host(value: &str) -> bool {
    value
        .parse::<axum::http::uri::Authority>()
        .is_ok_and(|authority| {
            let host = authority.host().trim_matches(['[', ']']);
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
}
pub(super) fn local_headers(headers: &HeaderMap) -> bool {
    let desktop_origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            matches!(
                value,
                "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
            )
        });
    let host_ok = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(loopback_host);
    let origin_ok = headers
        .get(header::ORIGIN)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| value.parse::<axum::http::Uri>().ok())
                .is_some_and(|uri| {
                    matches!(uri.scheme_str(), Some("http" | "https"))
                        && uri
                            .authority()
                            .is_some_and(|authority| loopback_host(authority.as_str()))
                })
        })
        .unwrap_or(true);
    let same_site = headers
        .get("sec-fetch-site")
        .is_none_or(|value| value != "cross-site");
    host_ok
        && (origin_ok || desktop_origin)
        // localhost and 127.0.0.1 are different browser sites, but both are
        // valid local UI origins. The outer origin guard still checks the
        // configured allowlist, and peer/Host/forwarded checks remain required.
        && (same_site || desktop_origin || (headers.contains_key(header::ORIGIN) && origin_ok))
        && ![
            "x-hanshu-remote-client",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
        ]
        .iter()
        .any(|name| headers.contains_key(*name))
}
pub(super) fn trusted_local(request: &Request<axum::body::Body>) -> bool {
    request
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .is_some_and(|peer| peer.0.ip().is_loopback())
        && local_headers(request.headers())
}
pub(super) async fn local_only(request: Request<axum::body::Body>, next: Next) -> Response {
    if !trusted_local(&request) {
        return ApiError(Error::new("forbidden", "请通过本机 WebUI 选择工程目录")).into_response();
    }
    next.run(request).await
}
async fn bootstrap(State(host): State<Arc<LocalHost>>) -> Json<Value> {
    Json(
        json!({ "service": "hanshu-local-projects", "version": 1, "token": host.token, "roots": host.roots }),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Browse {
    directory_id: String,
    #[serde(default)]
    filter: String,
}
async fn browse(
    State(host): State<Arc<LocalHost>>,
    headers: HeaderMap,
    Query(query): Query<Browse>,
) -> ApiResult {
    host.authenticate(&headers)?;
    if query.filter.len() > 256 {
        return Err(Error::new("invalid", "目录筛选文字过长").into());
    }
    let value = tokio::task::spawn_blocking(move || browse_directory(host, query))
        .await
        .map_err(|_| Error::new("storage", "目录读取失败，请重试"))??;
    Ok(Json(value))
}
fn browse_directory(host: Arc<LocalHost>, query: Browse) -> Result<Value> {
    let mut data = host.data.blocking_lock();
    let path = data.path(&query.directory_id)?;
    let directory = data.directory(&path, None)?;
    let parent = path
        .parent()
        .map(|parent| data.directory(parent, None))
        .transpose()?;
    let filter = query.filter.to_lowercase();
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in std::fs::read_dir(&path).map_err(directory_error)? {
        let Ok(entry) = entry else { continue };
        if !entry
            .file_name()
            .to_string_lossy()
            .to_lowercase()
            .contains(&filter)
            || !entry.path().is_dir()
        {
            continue;
        }
        if entries.len() >= 1000 {
            truncated = true;
            break;
        }
        if let Ok(directory) = data.directory(&entry.path(), None) {
            entries.push(directory);
        }
    }
    entries.sort_by_key(|directory| directory.name.to_lowercase());
    Ok(
        json!({ "directory": directory, "parent": parent, "entries": entries, "truncated": truncated }),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Open {
    directory_id: String,
    client_name: String,
}
async fn open(
    State(host): State<Arc<LocalHost>>,
    headers: HeaderMap,
    Json(request): Json<Open>,
) -> ApiResult {
    open_directory(host, headers, request, None).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    directory_id: String,
    client_name: String,
    name: String,
}
async fn create(
    State(host): State<Arc<LocalHost>>,
    headers: HeaderMap,
    Json(request): Json<Create>,
) -> ApiResult {
    open_directory(
        host,
        headers,
        Open {
            directory_id: request.directory_id,
            client_name: request.client_name,
        },
        Some(request.name),
    )
    .await
}
async fn open_directory(
    host: Arc<LocalHost>,
    headers: HeaderMap,
    request: Open,
    name: Option<String>,
) -> ApiResult {
    host.authenticate(&headers)?;
    // Keep lookup and startup serialized: two windows choosing one folder must
    // share its service, never compete for the same project's filesystem guard.
    if request.client_name.trim().is_empty() || request.client_name.chars().count() > 120 {
        return Err(Error::new("invalid", "本端名称需要填写，且不能超过 120 个字符").into());
    }
    let mut data = host.data.lock().await;
    let parent = data.path(&request.directory_id)?;
    if host
        .web_root
        .as_ref()
        .is_some_and(|web| parent.starts_with(web))
    {
        return Err(Error::new("invalid", "工程目录不能位于静态网页目录内").into());
    }
    if name.is_some() && data.projects.len() >= 16 {
        return Err(Error::new("busy", "本机已打开 16 个工程，请重启本机服务后再创建工程").into());
    }
    let root = if let Some(name) = name {
        create_project_directory(&parent, &name)?
    } else {
        parent
    };
    if !data.projects.contains_key(&root) {
        if data.projects.len() >= 16 {
            return Err(Error::new(
                "busy",
                "本机已打开 16 个工程，请重启本机服务后再打开其他工程",
            )
            .into());
        }
        let service = Box::pin(super::start_inner(
            &root,
            "127.0.0.1:0".parse().unwrap(),
            host.origins.clone(),
            None,
            false,
            Some(host.accounts.clone()),
        ))
        .await?;
        data.projects.insert(
            root.clone(),
            HostedProject {
                url: format!("http://{}", service.address),
                state: service.state.clone(),
                _service: Some(service),
            },
        );
    }
    let project = &data.projects[&root];
    let url = project.url.clone();
    let state = project.state.clone();
    let path = display_path(&root);
    drop(data);
    // The host authenticates internally. Recovery credentials never cross HTTP;
    // C receives the same short-lived session used by ordinary project clients.
    let engine = state.engine.clone();
    let token = tokio::task::spawn_blocking(move || -> Result<String> {
        let credential = std::fs::read_to_string(root.join(".hanshu/service/owner-key"))?;
        let (token, _) = engine
            .lock()
            .map_err(|_| Error::new("storage", "工程状态不可用"))?
            .login(credential.trim(), &request.client_name, now_ms())?;
        Ok(token)
    })
    .await
    .map_err(|_| Error::new("storage", "无法建立本机工程会话"))??;
    let _ = state.events.send(());
    Ok(Json(json!({ "url": url, "token": token, "path": path })))
}
pub(super) fn router(host: Arc<LocalHost>) -> Router {
    Router::new()
        .route("/api/local/bootstrap", get(bootstrap))
        .route("/api/local/directories", get(browse))
        .route(
            "/api/local/open",
            post(open).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/local/create",
            post(create).layer(DefaultBodyLimit::max(4096)),
        )
        .layer(middleware::from_fn(local_only))
        .with_state(host)
}

/// Trusted host operation: creates exactly one new child and never opens/overwrites an existing project.
pub fn create_project_directory(parent: &FsPath, name: &str) -> Result<PathBuf> {
    let reserved = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.trim().is_empty()
        || name != name.trim()
        || name.chars().count() > 100
        || name == "."
        || name == ".."
        || name.ends_with('.')
        || name
            .chars()
            .any(|ch| ch.is_control() || "/\\:*?\"<>|".contains(ch))
        || [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&reserved.as_str())
    {
        return Err(Error::new(
            "invalid",
            "请填写有效的工程名称，不要包含路径或特殊字符",
        ));
    }
    let root = parent.canonicalize()?.join(name);
    std::fs::create_dir(&root).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Error::new("conflict", "该位置已有同名文件夹，请换个名称或使用打开工程")
        } else {
            error.into()
        }
    })?;
    Ok(root)
}
