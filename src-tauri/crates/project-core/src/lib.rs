//! Transport-neutral, single-authority project service. Persisted subjects/grants/resources;
//! ephemeral sessions, presence and fenced per-session write leases. All times are server times.
mod files;
mod model;
mod progress;
mod resource_policy;
mod resource_relations;
mod skin_commands;
mod skin_patch;
pub use files::*;
pub use model::*;
pub use resource_policy::{
    FileEditAuthority, FileOperationKind, FileOperationRequest, PlannedFileOperation,
    ResourceOperationPlan,
};
pub use resource_relations::{
    ResourceRelation, ResourceRelationKind, ResourceRelationRole, ResourceRelations,
};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn digest(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn require(ok: bool, code: &'static str, message: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::new(code, message))
    }
}
fn text(value: &str) -> Result<()> {
    require(
        !value.trim().is_empty() && value.chars().count() <= 120,
        "invalid",
        "名称须为 1～120 个字符",
    )
}

pub struct Engine {
    root: PathBuf,
    data: model::Project,
    _guard: File,
    sessions: BTreeMap<String, (Session, String)>,
    leases: BTreeMap<String, Lease>,
    files: Option<ProjectFiles>,
    snapshot_sequence: Cell<u64>,
}

impl Engine {
    pub fn open(root: &Path) -> Result<Self> {
        fs::create_dir_all(root)?;
        let guard = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("service.lock"))?;
        fs4::FileExt::try_lock(&guard)
            .map_err(|_| Error::new("busy", "此工程已由另一个服务进程管理"))?;
        let file = root.join("project.json");
        let data = if file.exists() {
            let data: model::Project = serde_json::from_slice(&fs::read(&file)?)
                .map_err(|_| Error::new("storage", "工程数据损坏，拒绝覆盖"))?;
            require(
                data.version == 1
                    && data.grants.iter().any(|(id, r)| {
                        *r == Role::Owner && data.subjects.get(id).is_some_and(|s| s.enabled)
                    }),
                "storage",
                "工程格式或管理者信息无效",
            )?;
            data
        } else {
            let sid = id();
            // A local recovery credential is created before the project. It is never served over HTTP.
            let key = if root.join("owner-key").exists() {
                fs::read_to_string(root.join("owner-key"))?
            } else {
                let key = secret();
                let mut opts = OpenOptions::new();
                opts.create_new(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(0o600);
                }
                let mut f = opts.open(root.join("owner-key"))?;
                f.write_all(key.as_bytes())?;
                f.sync_all()?;
                key
            };
            let subject = Subject {
                id: sid.clone(),
                username: "Admin".into(),
                name: "Admin".into(),
                kind: "account".into(),
                enabled: true,
            };
            let data = model::Project {
                version: 1,
                id: id(),
                name: "共享工程".into(),
                revision: 0,
                subjects: BTreeMap::from([(sid.clone(), subject)]),
                grants: BTreeMap::from([(sid.clone(), Role::Owner)]),
                credentials: vec![model::Credential {
                    subject_id: sid,
                    digest: digest(key.trim()),
                }],
                resources: BTreeMap::new(),
            };
            Self::persist(root, &data)?;
            data
        };
        let mut data = data;
        for (id, subject) in data.subjects.iter_mut() {
            if data.grants.get(id) == Some(&Role::Owner) {
                subject.username = "Admin".into(); subject.name = "Admin".into();
            }
        }
        Self::persist(root, &data)?;
        Ok(Self {
            root: root.into(),
            data,
            _guard: guard,
            sessions: BTreeMap::new(),
            leases: BTreeMap::new(),
            files: None,
            snapshot_sequence: Cell::new(0),
        })
    }
    fn persist(root: &Path, data: &model::Project) -> Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        serde_json::to_writer(&mut file, data)
            .map_err(|_| Error::new("storage", "工程序列化失败"))?;
        file.as_file().sync_all()?;
        file.persist(root.join("project.json"))
            .map_err(|_| Error::new("storage", "工程替换失败，原内容未提交"))?;
        Ok(())
    }
    fn commit<T>(&mut self, f: impl FnOnce(&mut model::Project) -> Result<T>) -> Result<T> {
        let mut next = self.data.clone();
        let result = f(&mut next)?;
        next.revision += 1;
        Self::persist(&self.root, &next)?;
        self.data = next;
        Ok(result)
    }
    pub fn expire(&mut self, now: u64) -> bool {
        let before = (self.sessions.len(), self.leases.len());
        self.sessions.retain(|_, (s, _)| s.expires_at > now);
        self.leases
            .retain(|_, l| l.expires_at > now && self.sessions.contains_key(&l.session_id));
        for (s, _) in self.sessions.values_mut() {
            if !self
                .leases
                .values()
                .any(|l| l.session_id == s.id && s.resource_id.as_deref() == Some(&l.resource_id))
            {
                s.activity = "viewing".into();
            }
        }
        before != (self.sessions.len(), self.leases.len())
    }
    pub fn login(
        &mut self,
        credential: &str,
        client_name: &str,
        now: u64,
    ) -> Result<(String, Session)> {
        self.expire(now);
        text(client_name)?;
        require(self.sessions.len() < 128, "busy", "在线会话数已达上限")?;
        let sid = self
            .data
            .credentials
            .iter()
            .find(|c| c.digest == digest(credential))
            .map(|c| c.subject_id.clone())
            .ok_or_else(|| Error::new("unauthorized", "访问凭证无效"))?;
        require(
            self.data.subjects.get(&sid).is_some_and(|s| s.enabled)
                && self.data.grants.contains_key(&sid),
            "unauthorized",
            "主体已停用或未获工程权限",
        )?;
        self.login_subject(&sid, client_name, now)
    }
    /// Only a trusted authentication provider calls this after verifying identity.
    pub fn login_subject(&mut self, subject: &str, client_name: &str, now: u64) -> Result<(String, Session)> {
        self.expire(now); text(client_name)?;
        require(self.sessions.len() < 128, "busy", "在线会话数已达上限")?;
        require(self.data.subjects.get(subject).is_some_and(|s| s.enabled) && self.data.grants.contains_key(subject), "forbidden", "此账号未获工程权限")?;
        let token = secret();
        let session = Session {
            id: id(),
            subject_id: subject.to_owned(),
            client_name: client_name.trim().into(),
            expires_at: now + SESSION_TTL,
            resource_id: None,
            activity: "viewing".into(),
            file_presence: None,
        };
        self.sessions
            .insert(session.id.clone(), (session.clone(), digest(&token)));
        Ok((token, session))
    }
    pub fn bind_account(&mut self, sid: &str, subject: Subject, role: Role) -> Result<()> {
        self.owner(sid)?;
        require(role != Role::Owner && self.data.grants.get(&subject.id) != Some(&Role::Owner), "forbidden", "Admin 不能修改")?;
        text(&subject.name)?; text(&subject.username)?;
        self.commit(|d| { d.grants.insert(subject.id.clone(), role); d.subjects.insert(subject.id.clone(), subject); Ok(()) })
    }
    pub fn account_grant(&self, subject: &str) -> Option<Role> { self.data.grants.get(subject).copied() }
    pub fn sync_account(&mut self, subject: Subject) -> Result<()> {
        require(self.data.subjects.contains_key(&subject.id), "forbidden", "此账号未获工程权限")?;
        if self.data.subjects.get(&subject.id).is_some_and(|s| s.name == subject.name && s.username == subject.username && s.enabled == subject.enabled) { return Ok(()) }
        self.commit(|d| { d.subjects.insert(subject.id.clone(), subject); Ok(()) })
    }
    pub fn authenticate(&mut self, token: &str, now: u64) -> Result<String> {
        self.expire(now);
        let hashed = digest(token);
        let sid = self
            .sessions
            .values()
            .find(|(_, d)| *d == hashed)
            .map(|(s, _)| s.id.clone())
            .ok_or_else(|| Error::new("unauthorized", "会话已失效，请重新连接"))?;
        self.role(&sid)?;
        Ok(sid)
    }
    pub fn role(&self, session: &str) -> Result<Role> {
        let (s, _) = self
            .sessions
            .get(session)
            .ok_or_else(|| Error::new("unauthorized", "会话不存在"))?;
        require(
            self.data
                .subjects
                .get(&s.subject_id)
                .is_some_and(|p| p.enabled),
            "unauthorized",
            "主体已停用",
        )?;
        self.data
            .grants
            .get(&s.subject_id)
            .copied()
            .ok_or_else(|| Error::new("forbidden", "没有工程权限"))
    }
    fn writer(&self, sid: &str) -> Result<()> {
        require(
            self.role(sid)?.can_write(),
            "forbidden",
            "此主体只有读取权限",
        )
    }
    fn owner(&self, sid: &str) -> Result<()> {
        require(
            self.role(sid)? == Role::Owner,
            "forbidden",
            "需要工程管理权限",
        )
    }
    pub fn snapshot(&self, sid: &str) -> Result<Snapshot> {
        let role = self.role(sid)?;
        let status_version = self.snapshot_sequence.get() + 1;
        self.snapshot_sequence.set(status_version);
        let session = self.session_snapshot(&self.sessions[sid].0);
        Ok(Snapshot {
            status_version,
            server_time: now_ms(),
            project_id: self.data.id.clone(),
            project_name: self.data.name.clone(),
            revision: self.data.revision,
            files_revision: self.files.as_ref().map_or(0, |f| f.revision),
            session,
            role,
            members: self
                .data
                .subjects
                .values()
                .map(|s| Member {
                    subject: s.clone(),
                    role: self.data.grants[&s.id],
                })
                .collect(),
            resources: self
                .data
                .resources
                .values()
                .map(ResourceInfo::from)
                .collect(),
            sessions: self
                .sessions
                .values()
                .map(|(s, _)| self.session_snapshot(s))
                .collect(),
            leases: self.leases.values().cloned().collect(),
        })
    }
    pub fn logout(&mut self, sid: &str) {
        self.sessions.remove(sid);
        self.leases.retain(|_, l| l.session_id != sid);
    }
    pub fn heartbeat(
        &mut self,
        sid: &str,
        resource: Option<String>,
        lease: Option<&str>,
        typing: bool,
        now: u64,
    ) -> Result<()> {
        self.expire(now);
        self.role(sid)?;
        if let Some(id) = resource.as_ref() {
            require(
                self.data
                    .resources
                    .get(id)
                    .is_some_and(|r| r.kind != ResourceKind::Folder),
                "not_found",
                "查看的文档不存在",
            )?;
        }
        let owns = if let (Some(rid), Some(lid)) = (resource.as_ref(), lease) {
            self.require_lease(sid, rid, lid, now)?;
            self.leases.get_mut(rid).unwrap().expires_at = now + LEASE_TTL;
            true
        } else {
            false
        };
        let s = &mut self
            .sessions
            .get_mut(sid)
            .ok_or_else(|| Error::new("unauthorized", "会话已失效"))?
            .0;
        s.resource_id = resource;
        s.activity = if owns && typing {
            "typing"
        } else if owns {
            "editing"
        } else {
            "viewing"
        }
        .into();
        s.expires_at = now + SESSION_TTL;
        Ok(())
    }
    pub fn create_subject(
        &mut self,
        sid: &str,
        name: String,
        kind: String,
        role: Role,
    ) -> Result<(Subject, String)> {
        self.owner(sid)?;
        text(&name)?;
        text(&kind)?;
        require(role != Role::Owner, "invalid", "新主体可授予编辑或只读权限")?;
        let subject = Subject {
            id: id(),
            username: String::new(),
            name: name.trim().into(),
            kind: kind.trim().into(),
            enabled: true,
        };
        let key = secret();
        let s = subject.clone();
        self.commit(|d| {
            require(d.subjects.len() < 256, "busy", "主体数已达上限")?;
            d.subjects.insert(s.id.clone(), s.clone());
            d.grants.insert(s.id.clone(), role);
            d.credentials.push(model::Credential {
                subject_id: s.id,
                digest: digest(&key),
            });
            Ok(())
        })?;
        Ok((subject, key))
    }
    pub fn update_subject(&mut self, sid: &str, id: &str, role: Role, enabled: bool) -> Result<()> {
        self.owner(sid)?;
        require(
            role != Role::Owner && self.data.grants.get(id) != Some(&Role::Owner),
            "forbidden",
            "不能停用或改授工程管理者",
        )?;
        self.commit(|d| {
            d.subjects
                .get_mut(id)
                .ok_or_else(|| Error::new("not_found", "主体不存在"))?
                .enabled = enabled;
            d.grants.insert(id.into(), role);
            Ok(())
        })?;
        if !enabled || role == Role::Viewer {
            let affected: Vec<_> = self
                .sessions
                .values()
                .filter(|(s, _)| s.subject_id == id)
                .map(|(s, _)| s.id.clone())
                .collect();
            self.leases.retain(|_, l| !affected.contains(&l.session_id));
            if !enabled {
                for session in affected {
                    self.sessions.remove(&session);
                }
            } else {
                // Re-granting permission must not revive editing intent from before revocation.
                for session in affected {
                    if let Some(presence) =
                        &mut self.sessions.get_mut(&session).unwrap().0.file_presence
                    {
                        presence.activity = FileActivity::Viewing;
                    }
                }
            }
        }
        Ok(())
    }
    fn location(&self, parent: &Option<String>, name: &str, exclude: Option<&str>) -> Result<()> {
        text(name)?;
        require(
            name == name.trim()
                && name != "."
                && name != ".."
                && !name
                    .chars()
                    .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
                && !name.ends_with(['.', ' ']),
            "invalid",
            "文件名无效",
        )?;
        if let Some(parent) = parent {
            require(
                self.data
                    .resources
                    .get(parent)
                    .is_some_and(|r| r.kind == ResourceKind::Folder),
                "invalid",
                "父文件夹不存在",
            )?;
        }
        require(
            !self.data.resources.values().any(|r| {
                Some(r.id.as_str()) != exclude
                    && r.parent_id == *parent
                    && r.name.to_lowercase() == name.to_lowercase()
            }),
            "conflict",
            "同目录已有同名资源",
        )
    }
    pub fn create_resource(
        &mut self,
        sid: &str,
        parent: Option<String>,
        name: String,
        kind: ResourceKind,
        content: Option<String>,
    ) -> Result<Resource> {
        self.writer(sid)?;
        self.location(&parent, &name, None)?;
        if kind == ResourceKind::Progress {
            require(
                name.ends_with(".progress"),
                "invalid",
                "进度文件须使用 .progress 后缀",
            )?;
            progress::validate(content.as_deref().unwrap_or(""))?;
        } else if kind == ResourceKind::GoalDefinition {
            require(
                name.ends_with(".py") && content.as_ref().is_some_and(|s| s.len() <= 1024 * 1024),
                "invalid",
                "目标定义应为不超过 1 MiB 的 .py 脚本",
            )?;
        } else {
            require(content.is_none(), "invalid", "文件夹不能有正文")?;
        }
        let resource = Resource {
            id: id(),
            parent_id: parent,
            name,
            kind,
            revision: 1,
            content,
        };
        self.commit(|d| {
            require(d.resources.len() < 1024, "busy", "资源数已达上限")?;
            d.resources.insert(resource.id.clone(), resource.clone());
            Ok(resource)
        })
    }
    pub fn resource(&self, sid: &str, id: &str) -> Result<Resource> {
        self.role(sid)?;
        self.data
            .resources
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("not_found", "资源不存在"))
    }
    pub fn acquire(&mut self, sid: &str, id: &str, force: bool, now: u64) -> Result<Lease> {
        self.writer(sid)?;
        self.expire(now);
        require(
            self.resource(sid, id)?.kind != ResourceKind::Folder,
            "invalid",
            "文件夹不使用文档写权",
        )?;
        if force {
            self.owner(sid)?;
        }
        if let Some(l) = self.leases.get(id) {
            if l.session_id == sid {
                return Ok(l.clone());
            }
            require(force, "locked", "其他会话正在编辑此文档")?;
        }
        let lease = Lease {
            id: secret(),
            resource_id: id.into(),
            session_id: sid.into(),
            expires_at: now + LEASE_TTL,
        };
        self.leases.insert(id.into(), lease.clone());
        Ok(lease)
    }
    fn require_lease(&self, sid: &str, id: &str, lease: &str, now: u64) -> Result<()> {
        self.writer(sid)?;
        require(
            self.leases
                .get(id)
                .is_some_and(|l| l.id == lease && l.session_id == sid && l.expires_at > now),
            "locked",
            "写权已失效，本地草稿仍可保留",
        )
    }
    pub fn release(&mut self, sid: &str, id: &str, lease: &str, now: u64) -> Result<()> {
        self.require_lease(sid, id, lease, now)?;
        self.leases.remove(id);
        Ok(())
    }
    pub fn save(
        &mut self,
        sid: &str,
        id: &str,
        lease: &str,
        revision: u64,
        content: String,
        now: u64,
    ) -> Result<Resource> {
        self.require_lease(sid, id, lease, now)?;
        let r = self.resource(sid, id)?;
        require(
            r.revision == revision,
            "conflict",
            "文档版本已变化，保留草稿并重新读取",
        )?;
        if r.kind == ResourceKind::Progress {
            progress::validate(&content)?;
        } else {
            require(content.len() <= 1024 * 1024, "invalid", "目标定义脚本过大")?;
        }
        self.commit(|d| {
            let r = d.resources.get_mut(id).unwrap();
            r.content = Some(content);
            r.revision += 1;
            Ok(r.clone())
        })
    }
    pub fn rename(
        &mut self,
        sid: &str,
        id: &str,
        lease: Option<&str>,
        revision: u64,
        parent: Option<String>,
        name: String,
        now: u64,
    ) -> Result<Resource> {
        self.writer(sid)?;
        let r = self.resource(sid, id)?;
        require(r.revision == revision, "conflict", "资源版本已变化")?;
        self.location(&parent, &name, Some(id))?;
        if r.kind != ResourceKind::Folder {
            self.require_lease(sid, id, lease.unwrap_or(""), now)?;
            require(
                name.ends_with(if r.kind == ResourceKind::Progress {
                    ".progress"
                } else {
                    ".py"
                }),
                "invalid",
                "文件须保留原后缀",
            )?;
        } else {
            let mut p = parent.as_deref();
            while let Some(current) = p {
                require(current != id, "invalid", "文件夹不能移入自身或子目录")?;
                p = self
                    .data
                    .resources
                    .get(current)
                    .and_then(|r| r.parent_id.as_deref());
            }
            // Moving a folder changes the location of every descendant. Do not bypass their leases.
            for l in self.leases.values() {
                let mut p = Some(l.resource_id.as_str());
                while let Some(current) = p {
                    require(current != id, "locked", "子文档正在编辑，暂不能移动文件夹")?;
                    p = self
                        .data
                        .resources
                        .get(current)
                        .and_then(|r| r.parent_id.as_deref());
                }
            }
        }
        self.commit(|d| {
            let r = d.resources.get_mut(id).unwrap();
            r.name = name;
            r.parent_id = parent;
            r.revision += 1;
            Ok(r.clone())
        })
    }
    pub fn delete(
        &mut self,
        sid: &str,
        id: &str,
        lease: Option<&str>,
        revision: u64,
        now: u64,
    ) -> Result<()> {
        self.writer(sid)?;
        let r = self.resource(sid, id)?;
        require(r.revision == revision, "conflict", "资源版本已变化")?;
        if r.kind != ResourceKind::Folder {
            self.require_lease(sid, id, lease.unwrap_or(""), now)?;
        }
        require(
            !self
                .data
                .resources
                .values()
                .any(|r| r.parent_id.as_deref() == Some(id)),
            "conflict",
            "请先清空文件夹",
        )?;
        self.commit(|d| {
            d.resources.remove(id);
            Ok(())
        })?;
        self.leases.remove(id);
        for (s, _) in self.sessions.values_mut() {
            if s.resource_id.as_deref() == Some(id) {
                s.resource_id = None;
                s.activity = "viewing".into();
            }
        }
        Ok(())
    }
}
