//! Server identities persist; passwords and session tokens never leave their own boundary.
use super::*;
use argon2::{
    password_hash::{PasswordHash, SaltString},
    Argon2, PasswordHasher, PasswordVerifier,
};
use std::collections::BTreeMap;

const MAX_LOGIN_AGE: u64 = 8 * 60 * 60 * 1000;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    id: String,
    username: String,
    nickname: String,
    kind: String,
    enabled: bool,
    password_hash: String,
    generation: u64,
}
impl Account {
    fn subject(&self) -> project_core::Subject {
        project_core::Subject {
            id: self.id.clone(),
            username: self.username.clone(),
            name: self.nickname.clone(),
            kind: self.kind.clone(),
            enabled: self.enabled,
        }
    }
    fn public(&self, engine: &Engine) -> Value {
        json!({"id":self.id,"username":self.username,"nickname":self.nickname,"kind":self.kind,"enabled":self.enabled,"role":engine.account_grant(&self.id)})
    }
}
struct LoginSession {
    account: String,
    generation: u64,
    until: u64,
}
pub(super) struct Accounts {
    path: PathBuf,
    users: BTreeMap<String, Account>,
    sessions: BTreeMap<String, LoginSession>,
    attempts: BTreeMap<String, (u64, u32)>,
    dummy_hash: String,
}
fn hash(password: &str) -> Result<String> {
    let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
        .map_err(|_| Error::new("storage", "密码初始化失败"))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|value| value.to_string())
        .map_err(|_| Error::new("storage", "密码处理失败"))
}
fn valid_password(password: &str) -> Result<()> {
    if password.chars().count() < 10 || password.len() > 256 {
        return Err(Error::new("invalid", "密码至少 10 个字符，最多 256 字节"));
    }
    Ok(())
}
impl Accounts {
    pub(super) fn open(root: &FsPath) -> Result<Arc<Mutex<Self>>> {
        let path = root.join(".hanshu/service/accounts.json");
        let users = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path)?)
                .map_err(|_| Error::new("storage", "账号文件损坏，拒绝覆盖"))?
        } else {
            BTreeMap::new()
        };
        Ok(Arc::new(Mutex::new(Self {
            path,
            users,
            sessions: BTreeMap::new(),
            attempts: BTreeMap::new(),
            dummy_hash: hash(&uuid::Uuid::new_v4().to_string())?,
        })))
    }
    fn persist(&self, users: &BTreeMap<String, Account>) -> Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        serde_json::to_writer(&mut file, users)
            .map_err(|_| Error::new("storage", "账号保存失败"))?;
        file.as_file().sync_all()?;
        file.persist(&self.path)
            .map_err(|_| Error::new("storage", "账号替换失败"))?;
        Ok(())
    }
    pub(super) fn validate(
        &mut self,
        engine: &mut Engine,
        session: &str,
        now: u64,
        remote: bool,
    ) -> Result<()> {
        if engine.role(session)? == Role::Owner {
            if remote {
                return Err(Error::new("forbidden", "Admin 只允许本机登录和操作"));
            }
            return Ok(());
        }
        let grant = self
            .sessions
            .get(session)
            .ok_or_else(|| Error::new("unauthorized", "请使用用户名和密码重新登录"))?;
        let account = self
            .users
            .get(&grant.account)
            .filter(|u| u.enabled && u.generation == grant.generation && now < grant.until)
            .ok_or_else(|| Error::new("unauthorized", "登录已过期或账号已变更，请重新登录"))?;
        engine.sync_account(account.subject())?;
        Ok(())
    }
    pub(super) fn validate_session(
        &mut self,
        engine: &mut Engine,
        session: &str,
        now: u64,
        remote: bool,
    ) -> Result<()> {
        if let Err(error) = self.validate(engine, session, now, remote) {
            if !matches!(engine.role(session), Ok(Role::Owner)) {
                engine.logout(session);
                self.sessions.remove(session);
            }
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn revoke_session(&mut self, session: &str) {
        self.sessions.remove(session);
    }
}
pub(super) fn lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, Accounts>> {
    state
        .accounts
        .lock()
        .map_err(|_| Error::new("storage", "账号服务不可用"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Login {
    username: String,
    password: String,
    client_name: String,
}
pub(super) async fn login(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<SocketAddr>,
    Json(input): Json<Login>,
) -> ApiResult {
    let permit = state
        .login_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::new("busy", "登录请求繁忙，请稍后重试"))?;
    if input.username.len() > 64 || input.password.len() > 256 || input.client_name.len() > 360 {
        return Err(Error::new("unauthorized", "用户名或密码错误").into());
    }
    let cloned = state.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Value> {
        let _permit = permit;
        let mut accounts = lock(&cloned)?;
        let now = now_ms();
        accounts.attempts.retain(|_, (until, _)| *until > now);
        if accounts.attempts.len() > 2048 {
            return Err(Error::new("busy", "登录请求过多，请稍后重试"));
        }
        let attempt = accounts
            .attempts
            .entry(peer.ip().to_string())
            .or_insert((now + 60_000, 0));
        if attempt.1 >= 10 {
            return Err(Error::new("busy", "登录失败次数过多，请稍后重试"));
        }
        attempt.1 += 1;
        let user = accounts
            .users
            .values()
            .find(|u| u.username.eq_ignore_ascii_case(input.username.trim()))
            .cloned();
        let encoded = user
            .as_ref()
            .map(|u| u.password_hash.as_str())
            .unwrap_or(&accounts.dummy_hash);
        let valid = PasswordHash::new(encoded).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &hash)
                .is_ok()
        });
        let user = user
            .filter(|u| u.enabled && valid)
            .ok_or_else(|| Error::new("unauthorized", "用户名或密码错误"))?;
        let mut engine = cloned
            .engine
            .lock()
            .map_err(|_| Error::new("storage", "工程状态不可用"))?;
        engine.sync_account(user.subject())?;
        let (token, session) = engine.login_subject(&user.id, &input.client_name, now)?;
        accounts.sessions.retain(|_, s| s.until > now);
        accounts.sessions.insert(
            session.id.clone(),
            LoginSession {
                account: user.id,
                generation: user.generation,
                until: now + MAX_LOGIN_AGE,
            },
        );
        accounts.attempts.remove(&peer.ip().to_string());
        Ok(json!({"token":token,"session":session,"expiresAt":now+MAX_LOGIN_AGE}))
    })
    .await
    .map_err(|_| Error::new("storage", "登录任务失败"))??;
    let _ = state.events.send(());
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewAccount {
    username: String,
    nickname: String,
    password: String,
    #[serde(default = "account_kind")]
    kind: String,
    role: Role,
}
fn account_kind() -> String {
    "account".into()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    nickname: Option<String>,
    password: Option<String>,
    role: Option<Role>,
    enabled: Option<bool>,
}
async fn list(State(state): State<AppState>, h: HeaderMap) -> ApiResult {
    let sid = sharing::owner(&state, &h).await?;
    let accounts = lock(&state)?;
    let engine = state
        .engine
        .lock()
        .map_err(|_| Error::new("storage", "工程状态不可用"))?;
    let users: Vec<_> = accounts.users.values().map(|u| u.public(&engine)).collect();
    let _ = sid;
    Ok(Json(json!({"users":users})))
}
async fn create(
    State(state): State<AppState>,
    h: HeaderMap,
    Json(input): Json<NewAccount>,
) -> ApiResult {
    let sid = sharing::owner(&state, &h).await?;
    let cloned = state.clone();
    let value = tokio::task::spawn_blocking(move || -> Result<Value> {
        let username = input.username.trim();
        if username.len() < 3
            || username.len() > 40
            || !username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || username.eq_ignore_ascii_case("admin")
        {
            return Err(Error::new(
                "invalid",
                "用户名为 3～40 位字母、数字、点、下划线或连字符，Admin 为保留账号",
            ));
        }
        if input.nickname.trim().is_empty()
            || input.nickname.chars().count() > 120
            || input.role == Role::Owner
        {
            return Err(Error::new("invalid", "请填写昵称并选择编辑或只读权限"));
        }
        valid_password(&input.password)?;
        let mut accounts = lock(&cloned)?;
        if accounts.users.len() >= 255 {
            return Err(Error::new("busy", "账号数已达上限"));
        }
        if accounts
            .users
            .values()
            .any(|u| u.username.eq_ignore_ascii_case(username))
        {
            return Err(Error::new("conflict", "用户名已存在"));
        }
        let user = Account {
            id: uuid::Uuid::new_v4().to_string(),
            username: username.into(),
            nickname: input.nickname.trim().into(),
            kind: input.kind,
            enabled: true,
            password_hash: hash(&input.password)?,
            generation: 1,
        };
        let mut next = accounts.users.clone();
        next.insert(user.id.clone(), user.clone());
        accounts.persist(&next)?;
        accounts.users = next;
        let mut engine = cloned
            .engine
            .lock()
            .map_err(|_| Error::new("storage", "工程状态不可用"))?;
        engine.bind_account(&sid, user.subject(), input.role)?;
        Ok(json!({"user":user.public(&engine)}))
    })
    .await
    .map_err(|_| Error::new("storage", "创建账号失败"))??;
    let _ = state.events.send(());
    Ok(Json(value))
}
async fn update(
    State(state): State<AppState>,
    h: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<Update>,
) -> ApiResult {
    let sid = sharing::owner(&state, &h).await?;
    let cloned = state.clone();
    let value = tokio::task::spawn_blocking(move || -> Result<Value> {
        let mut accounts = lock(&cloned)?;
        let mut next = accounts.users.clone();
        let user = next
            .get_mut(&id)
            .ok_or_else(|| Error::new("not_found", "账号不存在，Admin 不可修改"))?;
        if let Some(name) = input.nickname {
            if name.trim().is_empty() || name.chars().count() > 120 {
                return Err(Error::new("invalid", "昵称须为 1～120 个字符"));
            }
            user.nickname = name.trim().into();
        }
        if let Some(password) = input.password {
            valid_password(&password)?;
            user.password_hash = hash(&password)?;
            user.generation += 1;
        }
        if let Some(enabled) = input.enabled {
            user.enabled = enabled;
            if !enabled {
                user.generation += 1;
            }
        }
        let user = user.clone();
        let mut engine = cloned
            .engine
            .lock()
            .map_err(|_| Error::new("storage", "工程状态不可用"))?;
        let role = input
            .role
            .or_else(|| engine.account_grant(&id))
            .unwrap_or(Role::Viewer);
        if role == Role::Owner {
            return Err(Error::new("forbidden", "不能创建或授予 Admin 权限"));
        }
        accounts.persist(&next)?;
        accounts.users = next;
        engine.bind_account(&sid, user.subject(), role)?;
        engine.update_subject(&sid, &id, role, user.enabled)?;
        Ok(json!({"user":user.public(&engine)}))
    })
    .await
    .map_err(|_| Error::new("storage", "账号更新失败"))??;
    let _ = state.events.send(());
    Ok(Json(value))
}
pub(super) fn management_routes() -> Router<AppState> {
    Router::new()
        .route("/api/accounts", get(list).post(create))
        .route("/api/accounts/{id}", axum::routing::patch(update))
        .layer(DefaultBodyLimit::max(4096))
        .layer(middleware::from_fn(local_projects::local_only))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absolute_expiry_and_password_generation_revoke_sessions() {
        let root = tempfile::tempdir().unwrap();
        let mut engine = Engine::open_project(root.path()).unwrap();
        let key = std::fs::read_to_string(root.path().join(".hanshu/service/owner-key")).unwrap();
        let (_, owner) = engine.login(key.trim(), "Admin", 1).unwrap();
        let store = Accounts::open(root.path()).unwrap();
        let mut accounts = store.lock().unwrap();
        let user = Account {
            id: "identity".into(),
            username: "writer".into(),
            nickname: "Writer".into(),
            kind: "account".into(),
            enabled: true,
            password_hash: hash("Test-password-123").unwrap(),
            generation: 1,
        };
        engine
            .bind_account(&owner.id, user.subject(), Role::Editor)
            .unwrap();
        accounts.users.insert(user.id.clone(), user.clone());
        let (_, session) = engine.login_subject(&user.id, "window", 1).unwrap();
        accounts.sessions.insert(
            session.id.clone(),
            LoginSession {
                account: user.id.clone(),
                generation: 1,
                until: MAX_LOGIN_AGE,
            },
        );
        assert!(accounts
            .validate_session(&mut engine, &session.id, MAX_LOGIN_AGE - 1, false)
            .is_ok());
        assert!(accounts
            .validate_session(&mut engine, &session.id, MAX_LOGIN_AGE, false)
            .is_err());
        assert!(engine.role(&session.id).is_err());
        let (_, session) = engine.login_subject(&user.id, "window", 2).unwrap();
        accounts.sessions.insert(
            session.id.clone(),
            LoginSession {
                account: user.id.clone(),
                generation: 1,
                until: MAX_LOGIN_AGE,
            },
        );
        accounts.users.get_mut(&user.id).unwrap().generation = 2;
        assert!(accounts
            .validate_session(&mut engine, &session.id, 3, false)
            .is_err());
    }
}
