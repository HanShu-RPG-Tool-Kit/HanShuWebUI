//! Import pipeline (port of `service/src/importPipeline.ts`): five import
//! kinds share one path after fetch.
//!
//!   png-file:    bytes → normalize → encode → stage
//!   png-url:     safe_fetch → same as png-file
//!   player-name: resolve → safe_fetch(skinUrl) → same; model from profile
//!   skin-code:   decode/validate → re-derive id → stage
//!   skin-file:   portable JSON v1/v2/v3 → validate embedded code → stage
//!
//! Jobs: queued → fetching/validating → ready (or failed/cancelled). Results
//! are staged in memory until the client saves; staged objects are protected
//! from GC. Cancellation uses a CancellationToken checked at await points.

use crate::codec::{decode_skin_code, encode_skin_code, limits, SkinModel};
use crate::error::{codes, SkinError, SkinResult};
use crate::network::player::resolve_player_skin;
use crate::network::safe_fetch;
use crate::normalize::{normalize_png, rgba_to_png};
use crate::storage::schema::{EntrySource, LicenseInfo, Provenance};
use crate::storage::{AddEntryInput, Storage};
use std::collections::HashSet;

use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportKind {
    PngFile,
    PngUrl,
    PlayerName,
    SkinCode,
    SkinFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Fetching,
    Validating,
    Ready,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub skin_id: String,
    pub model: SkinModel,
    pub suggested_name: String,
    pub skin_code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_tag_paths: Option<Vec<Vec<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_license: Option<LicenseInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_provenance: Option<Provenance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub job_id: String,
    pub kind: ImportKind,
    pub state: JobState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JobError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<ImportResult>,
    pub created_at: String,
    pub updated_at: String,
    /// Monotonic per-job sequence for event dedup on the client.
    pub seq: u64,
}

#[derive(Debug, Clone)]
pub struct Staged {
    pub skin_id: String,
    pub model: SkinModel,
    pub skin_code: String,
    pub suggested_name: String,
    pub suggested_tag_paths: Option<Vec<Vec<String>>>,
    pub suggested_active: Option<bool>,
    pub suggested_license: Option<LicenseInfo>,
    pub suggested_provenance: Option<Provenance>,
    pub suggested_note: Option<String>,
    pub source: EntrySource,
}

struct JobEntry {
    job: ImportJob,
    staged: Option<Staged>,
    cancel: CancellationToken,
}

#[derive(Debug, Clone)]
pub enum ImportInput {
    PngFile { bytes: Vec<u8>, file_name: String, model_override: SkinModel },
    PngUrl { url: String, model_override: SkinModel },
    PlayerName { name: String },
    SkinCode { code: String },
    SkinFile { bytes: Vec<u8>, file_name: Option<String> },
}

pub struct ImportManager {
    storage: Arc<Storage>,
    jobs: Mutex<Vec<Arc<Mutex<JobEntry>>>>,
    /// Bounded network + codec concurrency (engineering defaults).
    net_sem: tokio::sync::Semaphore,
    cpu_sem: tokio::sync::Semaphore,
}

fn now_iso() -> String {
    crate::storage::now_iso_public()
}

impl ImportManager {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self {
            storage,
            jobs: Mutex::new(Vec::new()),
            net_sem: tokio::sync::Semaphore::new(4),
            cpu_sem: tokio::sync::Semaphore::new(2),
        }
    }

    pub fn get(&self, job_id: &str) -> Option<ImportJob> {
        let jobs = self.jobs.lock().unwrap();
        jobs.iter()
            .find(|j| j.lock().unwrap().job.job_id == job_id)
            .map(|j| j.lock().unwrap().job.clone())
    }

    pub fn list(&self) -> Vec<ImportJob> {
        let jobs = self.jobs.lock().unwrap();
        jobs.iter().map(|j| j.lock().unwrap().job.clone()).collect()
    }

    pub fn take_staged(&self, job_id: &str) -> Option<Staged> {
        let jobs = self.jobs.lock().unwrap();
        jobs.iter()
            .find(|j| j.lock().unwrap().job.job_id == job_id)
            .and_then(|j| j.lock().unwrap().staged.clone())
    }

    /// skinIds staged by active jobs — protected from GC.
    pub fn staged_skin_ids(&self) -> HashSet<String> {
        let jobs = self.jobs.lock().unwrap();
        let mut ids = HashSet::new();
        for j in jobs.iter() {
            let entry = j.lock().unwrap();
            if let Some(staged) = &entry.staged {
                ids.insert(staged.skin_id.clone());
            }
        }
        ids
    }

    /// Best-effort cancel: queued jobs stop before fetching; in-flight jobs
    /// observe the token at await points. Jobs already committing finish.
    pub fn cancel(&self, job_id: &str) -> Option<ImportJob> {
        let jobs = self.jobs.lock().unwrap();
        let entry = jobs
            .iter()
            .find(|j| j.lock().unwrap().job.job_id == job_id)?
            .clone();
        drop(jobs);
        let mut e = entry.lock().unwrap();
        if e.job.state == JobState::Queued {
            e.cancel.cancel();
            set_state(&mut e.job, JobState::Cancelled, Some(JobError {
                code: codes::JOB_CANCELLED.to_string(),
                message: "cancelled".into(),
            }));
        } else {
            e.cancel.cancel();
        }
        Some(e.job.clone())
    }

    /// Register the job, then run it in the background. Returns immediately.
    pub fn start(self: &Arc<Self>, input: ImportInput) -> ImportJob {
        let job = ImportJob {
            job_id: uuid::Uuid::new_v4().to_string(),
            kind: kind_of(&input),
            state: JobState::Queued,
            error: None,
            result: None,
            created_at: now_iso(),
            updated_at: now_iso(),
            seq: 0,
        };
        let entry = Arc::new(Mutex::new(JobEntry {
            job: job.clone(),
            staged: None,
            cancel: CancellationToken::new(),
        }));
        self.jobs.lock().unwrap().push(entry.clone());
        let mgr = self.clone();
        spawn_detached(async move {
            if let Err(e) = mgr.run(entry.clone(), input).await {
                let mut e2 = entry.lock().unwrap();
                if e2.job.state != JobState::Cancelled {
                    set_state(
                        &mut e2.job,
                        JobState::Failed,
                        Some(JobError { code: e.code().to_string(), message: e.to_string() }),
                    );
                }
            }
        });
        job
    }

    async fn run(&self, entry: Arc<Mutex<JobEntry>>, input: ImportInput) -> SkinResult<()> {
        let token = entry.lock().unwrap().cancel.clone();
        // Wait for a network slot (bounded concurrency).
        let _net = self.net_sem.acquire().await;
        if token.is_cancelled() {
            return Err(SkinError::api(codes::JOB_CANCELLED, "cancelled"));
        }
        match input {
            ImportInput::PngFile { bytes, file_name, model_override } => {
                let source = EntrySource::PngFile { file_name: Some(file_name.clone()) };
                self.run_png(entry, &token, &bytes, file_name, model_override, source).await
            }
            ImportInput::PngUrl { url, model_override } => {
                set_state_arc(&entry, JobState::Fetching, None);
                let res = safe_fetch(&url).await?;
                if token.is_cancelled() {
                    return Err(SkinError::api(codes::JOB_CANCELLED, "cancelled"));
                }
                let file_name = url
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("skin.png")
                    .to_string();
                let source = EntrySource::PngUrl { url };
                self.run_png(entry, &token, &res.body, file_name, model_override, source).await
            }
            ImportInput::PlayerName { name } => {
                set_state_arc(&entry, JobState::Fetching, None);
                let name = name.trim().to_string();
                let resolved = resolve_player_skin(&name).await?;
                let res = safe_fetch(&resolved.skin_url).await?;
                if token.is_cancelled() {
                    return Err(SkinError::api(codes::JOB_CANCELLED, "cancelled"));
                }
                let source = EntrySource::PlayerName {
                    player_name: resolved.player_name.clone(),
                    uuid: Some(resolved.uuid.clone()),
                };
                self.run_png(
                    entry,
                    &token,
                    &res.body,
                    resolved.player_name.clone(),
                    resolved.model,
                    source,
                )
                .await
            }
            ImportInput::SkinCode { code } => {
                set_state_arc(&entry, JobState::Validating, None);
                let code = code.trim().to_string();
                let _cpu = self.cpu_sem.acquire().await;
                let (decoded, _) = decode_skin_code(&code)?;
                let (skin_id, model) = self.storage.put_object(&code)?;
                let png = rgba_to_png(&decoded.rgba)?;
                self.storage.put_preview_png(&skin_id, &png)?;
                let suggested_name = format!("skin-{}", &skin_id[..8]);
                self.stage(
                    entry,
                    Staged {
                        skin_id,
                        model,
                        skin_code: code,
                        suggested_name,
                        suggested_tag_paths: None,
                        suggested_active: None,
                        suggested_license: None,
                        suggested_provenance: None,
                        suggested_note: None,
                        source: EntrySource::SkinCode,
                    },
                )
            }
            ImportInput::SkinFile { bytes, file_name } => {
                set_state_arc(&entry, JobState::Validating, None);
                if bytes.len() > limits::PORTABLE_JSON_BYTES {
                    return Err(SkinError::api(
                        codes::PAYLOAD_TOO_LARGE,
                        format!("portable file exceeds {}", limits::PORTABLE_JSON_BYTES),
                    ));
                }
                let parsed: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|_| SkinError::api(codes::BAD_REQUEST, "portable file is not valid JSON"))?;
                let version = parsed.get("schemaVersion").and_then(|v| v.as_u64());
                if !matches!(version, Some(1) | Some(2) | Some(3)) {
                    return Err(SkinError::api(
                        codes::BAD_REQUEST,
                        "portable file missing schemaVersion=1|2|3/skinCode",
                    ));
                }
                let skin_code = parsed
                    .get("skinCode")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        SkinError::api(
                            codes::BAD_REQUEST,
                            "portable file missing schemaVersion=1|2|3/skinCode",
                        )
                    })?
                    .to_string();
                // Re-validate the embedded code; never trust the file's own skinId.
                let (decoded, verified_id) = decode_skin_code(&skin_code)?;
                if let Some(claimed) = parsed.get("skinId").and_then(|v| v.as_str()) {
                    if claimed != verified_id {
                        return Err(SkinError::api(
                            codes::FORMAT_ERROR,
                            "skinId mismatch with skinCode",
                        ));
                    }
                }
                // Suggestions only — nodes are created when the user saves.
                let suggested_tag_paths: Option<Vec<Vec<String>>> = match version {
                    Some(3) | Some(2) => parsed.get("tagPaths").and_then(|v| v.as_array()).map(|arr| {
                        arr.iter()
                            .filter_map(|p| p.as_array())
                            .map(|p| {
                                p.iter()
                                    .filter_map(|s| s.as_str())
                                    .filter(|s| !s.trim().is_empty())
                                    .map(|s| s.to_string())
                                    .collect::<Vec<String>>()
                            })
                            .filter(|p| !p.is_empty())
                            .take(64)
                            .collect::<Vec<Vec<String>>>()
                    }),
                    _ => parsed.get("tags").and_then(|v| v.as_array()).map(|arr| {
                        arr.iter()
                            .filter_map(|s| s.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                            .take(32)
                            .map(|t| vec![t])
                            .collect::<Vec<Vec<String>>>()
                    }),
                };
                let suggested_name = parsed
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .or_else(|| file_name.as_deref().map(|f| f.to_string()))
                    .unwrap_or_else(|| format!("skin-{}", &verified_id[..8]));
                let suggested_active = parsed.get("active").and_then(|v| v.as_bool());
                let suggested_license = parsed.get("license").and_then(|v| {
                    serde_json::from_value::<LicenseInfo>(v.clone()).ok()
                });
                let suggested_provenance = parsed.get("provenance").and_then(|v| {
                    serde_json::from_value::<Provenance>(v.clone()).ok()
                });
                let suggested_note = parsed.get("note").and_then(|v| v.as_str()).map(|s| s.to_string());
                let (skin_id, model) = self.storage.put_object(&skin_code)?;
                let png = rgba_to_png(&decoded.rgba)?;
                self.storage.put_preview_png(&skin_id, &png)?;
                self.stage(
                    entry,
                    Staged {
                        skin_id,
                        model,
                        skin_code,
                        suggested_name,
                        suggested_tag_paths,
                        suggested_active,
                        suggested_license,
                        suggested_provenance,
                        suggested_note,
                        source: EntrySource::SkinFile { file_name },
                    },
                )
            }
        }
    }

    async fn run_png(
        &self,
        entry: Arc<Mutex<JobEntry>>,
        token: &CancellationToken,
        bytes: &[u8],
        file_name: String,
        model: SkinModel,
        source: EntrySource,
    ) -> SkinResult<()> {
        set_state_arc(&entry, JobState::Validating, None);
        let _cpu = self.cpu_sem.acquire().await;
        if token.is_cancelled() {
            return Err(SkinError::api(codes::JOB_CANCELLED, "cancelled"));
        }
        let normalized = normalize_png(bytes)?;
        let skin_code = encode_skin_code(model, &normalized.rgba)?;
        let (skin_id, model) = self.storage.put_object(&skin_code)?;
        let png = rgba_to_png(&normalized.rgba)?;
        self.storage.put_preview_png(&skin_id, &png)?;
        let suggested_name = strip_ext(&file_name);
        self.stage(
            entry,
            Staged {
                skin_id,
                model,
                skin_code,
                suggested_name,
                suggested_tag_paths: None,
                suggested_active: None,
                suggested_license: None,
                suggested_provenance: None,
                suggested_note: None,
                source,
            },
        )
    }

    fn stage(&self, entry: Arc<Mutex<JobEntry>>, staged: Staged) -> SkinResult<()> {
        let mut e = entry.lock().unwrap();
        if e.cancel.is_cancelled() {
            return Err(SkinError::api(codes::JOB_CANCELLED, "cancelled"));
        }
        e.job.result = Some(ImportResult {
            skin_id: staged.skin_id.clone(),
            model: staged.model,
            suggested_name: staged.suggested_name.clone(),
            skin_code: staged.skin_code.clone(),
            suggested_tag_paths: staged.suggested_tag_paths.clone(),
            suggested_active: staged.suggested_active,
            suggested_license: staged.suggested_license.clone(),
            suggested_provenance: staged.suggested_provenance.clone(),
            suggested_note: staged.suggested_note.clone(),
        });
        e.staged = Some(staged);
        set_state(&mut e.job, JobState::Ready, None);
        Ok(())
    }

    /// Save a ready job as a library entry (two-phase import, phase 2).
    pub fn save_entry(
        &self,
        job_id: &str,
        name: &str,
        tag_ids: Vec<String>,
        tag_paths: Vec<Vec<String>>,
        folder_id: Option<String>,
        favorite: bool,
        active: Option<bool>,
        license: Option<LicenseInfo>,
        provenance: Option<Provenance>,
        note: Option<String>,
    ) -> SkinResult<crate::storage::schema::LibraryEntry> {
        let staged = self
            .take_staged(job_id)
            .ok_or_else(|| SkinError::api(codes::CONFLICT, "import job not ready"))?;
        let job = self
            .get(job_id)
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "job not found"))?;
        if job.state != JobState::Ready {
            return Err(SkinError::api(codes::CONFLICT, "import job not ready"));
        }
        // Direct tagIds come from the picker; tagPaths (portable import) are
        // resolved/created now — at save time, never during preview.
        let mut final_tag_ids = tag_ids;
        if !tag_paths.is_empty() {
            let (resolved, _) = self.storage.resolve_tag_paths(&tag_paths)?;
            for id in resolved {
                if !final_tag_ids.contains(&id) {
                    final_tag_ids.push(id);
                }
            }
        } else if let Some(suggested) =
            staged.suggested_tag_paths.as_ref().filter(|p| !p.is_empty())
        {
            if final_tag_ids.is_empty() {
                let (resolved, _) = self.storage.resolve_tag_paths(suggested)?;
                final_tag_ids = resolved;
            }
        }
        final_tag_ids.truncate(64);
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err(SkinError::api(codes::BAD_REQUEST, "name required"));
        }
        self.storage.add_entry(AddEntryInput {
            skin_id: staged.skin_id.clone(),
            name,
            active: active.or(staged.suggested_active).unwrap_or(false),
            tag_ids: final_tag_ids,
            folder_id,
            favorite,
            model: staged.model,
            source: staged.source,
            provenance: provenance.or(staged.suggested_provenance).unwrap_or_default(),
            license: license.or(staged.suggested_license).unwrap_or_default(),
            note: note.or(staged.suggested_note).unwrap_or_default(),
        })
    }
}

fn kind_of(input: &ImportInput) -> ImportKind {
    match input {
        ImportInput::PngFile { .. } => ImportKind::PngFile,
        ImportInput::PngUrl { .. } => ImportKind::PngUrl,
        ImportInput::PlayerName { .. } => ImportKind::PlayerName,
        ImportInput::SkinCode { .. } => ImportKind::SkinCode,
        ImportInput::SkinFile { .. } => ImportKind::SkinFile,
    }
}

fn set_state(job: &mut ImportJob, state: JobState, error: Option<JobError>) {
    job.state = state;
    job.updated_at = now_iso();
    job.seq += 1;
    job.error = error;
}

fn set_state_arc(entry: &Arc<Mutex<JobEntry>>, state: JobState, error: Option<JobError>) {
    let mut e = entry.lock().unwrap();
    set_state(&mut e.job, state, error);
}

fn strip_ext(name: &str) -> String {
    let lower = name.to_lowercase();
    for ext in [".skin.json", ".png", ".hskin", ".json"] {
        if lower.ends_with(ext) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name.to_string()
}

/// The core crate never creates its own runtime; the Tauri adapter injects
/// this spawner (tauri::async_runtime::spawn). Tests install their own.
pub type SpawnFn = fn(fut: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>);

static SPAWN_HOOK: std::sync::OnceLock<SpawnFn> = std::sync::OnceLock::new();

pub fn set_spawn_hook(hook: SpawnFn) {
    let _ = SPAWN_HOOK.set(hook);
}

fn spawn_detached<F: std::future::Future<Output = ()> + Send + 'static>(fut: F) {
    if let Some(hook) = SPAWN_HOOK.get() {
        hook(Box::pin(fut));
    } else {
        // No hook installed (unit tests without a runtime): run inline on a
        // current-thread runtime if possible, else drop. Integration tests
        // always install a hook or drive the manager inside #[tokio::test].
        drop(fut);
    }
}
