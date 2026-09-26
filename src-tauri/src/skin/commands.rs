//! IPC commands: thin adapters over skin-core. DTOs use camelCase JSON;
//! errors carry a stable `code` + `message` (+ optional `retryAfterMs`).
//! Library calls that may wait on the write lock run in spawn_blocking.

use super::events;
use super::state::SkinState;
use skin_core::codec::{decode_skin_code, SkinModel};
use skin_core::error::codes;
use skin_core::imports::{ImportInput, ImportJob, JobState};
use skin_core::normalize::rgba_to_png;
use skin_core::storage::schema::{LibraryEntry, PortableSkinFileV2, PortableSkinFileV3};
use skin_core::storage::{BatchPatch, CollectedTag, LibraryQuery, PatchEntry, PatchFolder, Storage};
use skin_core::SkinError;
use std::sync::Arc;
use tauri::ipc::Response;
use tauri::{AppHandle, State};

fn b64_encode(data: &[u8]) -> String {
    // Delegate to skin-core's base64 dependency via a tiny local re-export.
    skin_core::codec::base64_standard(data)
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

impl From<SkinError> for CommandError {
    fn from(e: SkinError) -> Self {
        CommandError {
            code: e.code().to_string(),
            message: e.to_string(),
            retry_after_ms: e.retry_after_ms(),
        }
    }
}

type CmdResult<T> = Result<T, CommandError>;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub tool_version: String,
    pub api_version: String,
    pub library_schema_version: u32,
    pub format_version: u32,
    pub import_kinds: [&'static str; 5],
    pub live_apply: bool,
    pub features: CapabilitiesFeatures,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesFeatures {
    pub batch_active: bool,
    pub http_api: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagListResponse {
    pub revision: u64,
    pub tags: Vec<CollectedTag>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTreeResponse {
    pub revision: u64,
    pub folders: Vec<skin_core::storage::FolderWithStats>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNodeRequest {
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEntryRequest {
    pub job_id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tag_paths: Vec<Vec<String>>,
    pub folder_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub license: Option<skin_core::storage::schema::LicenseInfo>,
    #[serde(default)]
    pub provenance: Option<skin_core::storage::schema::Provenance>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartImportRequest {
    pub kind: String,
    pub text: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    pub file_name: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAccepted {
    pub job_id: String,
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn parse_model(s: &Option<String>) -> SkinModel {
    if s.as_deref() == Some("slim") {
        SkinModel::Slim
    } else {
        SkinModel::Classic
    }
}

/// Run a library operation on a blocking worker (std Mutex + disk IO).
async fn with_library<T, F>(state: &State<'_, SkinState>, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(Arc<Storage>) -> Result<T, SkinError> + Send + 'static,
{
    let library = state.service.library.clone();
    tauri::async_runtime::spawn_blocking(move || f(library))
        .await
        .map_err(|e| SkinError::api(codes::INTERNAL, format!("blocking task failed: {e}")))?
        .map_err(CommandError::from)
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn skin_get_capabilities() -> CmdResult<Capabilities> {
    Ok(Capabilities {
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: "1.0.0".to_string(),
        library_schema_version: skin_core::storage::schema::SCHEMA_VERSION,
        format_version: 1,
        import_kinds: ["png-file", "png-url", "player-name", "skin-code", "skin-file"],
        live_apply: false,
        features: CapabilitiesFeatures {
            batch_active: true,
            http_api: false,
        },
    })
}

#[tauri::command]
pub async fn skin_list_entries(
    state: State<'_, SkinState>,
    query: LibraryQuery,
) -> CmdResult<skin_core::storage::LibraryPage> {
    with_library(&state, move |lib| Ok(lib.list_entries(&query))).await
}

#[tauri::command]
pub async fn skin_get_entry(
    state: State<'_, SkinState>,
    entry_id: String,
) -> CmdResult<LibraryEntry> {
    with_library(&state, move |lib| {
        lib.get_entry(&entry_id)
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "entry not found"))
    })
    .await
}

#[tauri::command]
pub async fn skin_list_tags(state: State<'_, SkinState>) -> CmdResult<TagListResponse> {
    with_library(&state, move |lib| {
        let (revision, tags) = lib.list_tags();
        Ok(TagListResponse { revision, tags })
    })
    .await
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameTagRequest {
    pub from: String,
    pub to: String,
}

#[tauri::command]
pub async fn skin_rename_tag(
    app: AppHandle,
    state: State<'_, SkinState>,
    body: RenameTagRequest,
) -> CmdResult<serde_json::Value> {
    let out = with_library(&state, move |lib| {
        let (affected, _revision) = lib.rename_tag(&body.from, &body.to)?;
        Ok(serde_json::json!({ "affectedEntries": affected }))
    })
    .await?;
    events::emit_library_updated(&app, &state, "tags");
    events::emit_library_updated(&app, &state, "entries");
    Ok(out)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTagRequest {
    pub name: String,
}

#[tauri::command]
pub async fn skin_delete_tag(
    app: AppHandle,
    state: State<'_, SkinState>,
    body: DeleteTagRequest,
) -> CmdResult<serde_json::Value> {
    let out = with_library(&state, move |lib| {
        let (affected, _revision) = lib.delete_tag(&body.name)?;
        Ok(serde_json::json!({ "affectedEntries": affected }))
    })
    .await?;
    events::emit_library_updated(&app, &state, "tags");
    events::emit_library_updated(&app, &state, "entries");
    Ok(out)
}

#[tauri::command]
pub async fn skin_list_folders(state: State<'_, SkinState>) -> CmdResult<FolderTreeResponse> {
    with_library(&state, move |lib| {
        let (revision, folders) = lib.folder_tree_with_stats();
        Ok(FolderTreeResponse { revision, folders })
    })
    .await
}

#[tauri::command]
pub async fn skin_create_folder(
    app: AppHandle,
    state: State<'_, SkinState>,
    body: CreateNodeRequest,
) -> CmdResult<skin_core::storage::schema::FolderNode> {
    let out =
        with_library(&state, move |lib| lib.create_folder(&body.name, body.parent_id)).await?;
    events::emit_library_updated(&app, &state, "folders");
    Ok(out)
}

#[tauri::command]
pub async fn skin_patch_folder(
    app: AppHandle,
    state: State<'_, SkinState>,
    folder_id: String,
    patch: PatchFolder,
) -> CmdResult<skin_core::storage::schema::FolderNode> {
    let out = with_library(&state, move |lib| lib.patch_folder(&folder_id, patch)).await?;
    events::emit_library_updated(&app, &state, "folders");
    Ok(out)
}

#[tauri::command]
pub async fn skin_delete_folder(
    app: AppHandle,
    state: State<'_, SkinState>,
    folder_id: String,
) -> CmdResult<serde_json::Value> {
    let out = with_library(&state, move |lib| {
        lib.delete_folder(&folder_id)?;
        Ok(serde_json::json!({ "deleted": true }))
    })
    .await?;
    events::emit_library_updated(&app, &state, "folders");
    Ok(out)
}

#[tauri::command]
pub async fn skin_save_entry(
    app: AppHandle,
    state: State<'_, SkinState>,
    body: SaveEntryRequest,
) -> CmdResult<LibraryEntry> {
    let imports = state.service.imports.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        imports
            .save_entry(
                &body.job_id,
                &body.name,
                body.tags,
                body.tag_paths,
                body.folder_id,
                body.favorite,
                body.active,
                body.license,
                body.provenance,
                body.note,
            )
            .map_err(CommandError::from)
    })
    .await
    .map_err(|e| SkinError::api(codes::INTERNAL, e.to_string()))??;
    events::emit_library_updated(&app, &state, "entries");
    events::emit_library_updated(&app, &state, "tags");
    Ok(out)
}

#[tauri::command]
pub async fn skin_patch_entry(
    app: AppHandle,
    state: State<'_, SkinState>,
    entry_id: String,
    revision: u64,
    patch: PatchEntry,
) -> CmdResult<LibraryEntry> {
    let touched_tags =
        patch.tags.is_some() || patch.add_tags.is_some() || patch.remove_tags.is_some();
    let touched_folder = patch.folder_id.is_some();
    let out = with_library(&state, move |lib| lib.patch_entry(&entry_id, revision, patch)).await?;
    events::emit_library_updated(&app, &state, "entries");
    if touched_tags {
        events::emit_library_updated(&app, &state, "tags");
    }
    if touched_folder {
        events::emit_library_updated(&app, &state, "folders");
    }
    Ok(out)
}

#[tauri::command]
pub async fn skin_batch_patch_entries(
    app: AppHandle,
    state: State<'_, SkinState>,
    batch: BatchPatch,
) -> CmdResult<serde_json::Value> {
    if batch.entry_ids.is_empty() {
        return Err(SkinError::api(codes::BAD_REQUEST, "entryIds required").into());
    }
    if batch.entry_ids.len() > 500 {
        return Err(SkinError::api(codes::BAD_REQUEST, "too many entries").into());
    }
    let out = with_library(&state, move |lib| {
        let (updated, revision) = lib.batch_patch_entries(batch)?;
        Ok(serde_json::json!({ "updated": updated, "revision": revision }))
    })
    .await?;
    events::emit_library_updated(&app, &state, "entries");
    events::emit_library_updated(&app, &state, "tags");
    Ok(out)
}

#[tauri::command]
pub async fn skin_delete_entry(
    app: AppHandle,
    state: State<'_, SkinState>,
    entry_id: String,
) -> CmdResult<serde_json::Value> {
    let out = with_library(&state, move |lib| {
        let ok = lib.remove_entry(&entry_id)?;
        if !ok {
            return Err(SkinError::api(codes::NOT_FOUND, "entry not found"));
        }
        Ok(serde_json::json!({ "deleted": true }))
    })
    .await?;
    events::emit_library_updated(&app, &state, "entries");
    events::emit_library_updated(&app, &state, "tags");
    Ok(out)
}

/// Poll a job and emit `skin://job-updated` on every state change until
/// terminal. The job registry stays the source of truth; events are hints.
async fn watch_job(app: AppHandle, mgr: std::sync::Arc<skin_core::imports::ImportManager>, job_id: String) {
    let mut last_seq = 0u64;
    for _ in 0..600 {
        let Some(job) = mgr.get(&job_id) else { return };
        if job.seq > last_seq {
            last_seq = job.seq;
            events::emit_job_updated(&app, &job);
        }
        if matches!(job.state, JobState::Ready | JobState::Failed | JobState::Cancelled) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[tauri::command]
pub async fn skin_start_import(
    app: AppHandle,
    state: State<'_, SkinState>,
    body: StartImportRequest,
) -> CmdResult<ImportAccepted> {
    let mgr = state.service.imports.clone();
    let input = match body.kind.as_str() {
        "png-url" => ImportInput::PngUrl {
            url: body.text.unwrap_or_default(),
            model_override: parse_model(&body.model),
        },
        "player-name" => ImportInput::PlayerName {
            name: body.text.unwrap_or_default(),
        },
        "skin-code" => ImportInput::SkinCode {
            code: body.text.unwrap_or_default(),
        },
        "skin-file" => ImportInput::SkinFile {
            bytes: body.text.unwrap_or_default().into_bytes(),
            file_name: body.file_name,
        },
        other => {
            return Err(
                SkinError::api(codes::BAD_REQUEST, format!("unknown kind {other}")).into()
            );
        }
    };
    let job = mgr.start(input);
    let job_id = job.job_id.clone();
    tauri::async_runtime::spawn(watch_job(app, mgr, job_id));
    Ok(ImportAccepted { job_id: job.job_id })
}

/// Native file import: the path comes from the dialog plugin (never the
/// renderer), bytes are read with a bounded read inside the command.
#[tauri::command]
pub async fn skin_import_file(
    app: AppHandle,
    state: State<'_, SkinState>,
    path: String,
    model: Option<String>,
) -> CmdResult<ImportAccepted> {
    let mgr = state.service.imports.clone();
    let file_name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string());
    let is_portable = file_name
        .as_deref()
        .map(|n| n.to_lowercase().ends_with(".skin.json"))
        .unwrap_or(false);
    let cap = if is_portable {
        skin_core::codec::limits::PORTABLE_JSON_BYTES
    } else {
        skin_core::codec::limits::PNG_BYTES
    };
    let path_for_read = path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path_for_read)
            .map_err(|e| SkinError::api(codes::BAD_REQUEST, e.to_string()))
    })
    .await
    .map_err(|e| SkinError::api(codes::INTERNAL, e.to_string()))??;
    if bytes.len() > cap {
        return Err(
            SkinError::api(codes::PAYLOAD_TOO_LARGE, format!("file exceeds {cap} bytes"))
                .into(),
        );
    }
    let input = if is_portable {
        ImportInput::SkinFile { bytes, file_name }
    } else {
        ImportInput::PngFile {
            bytes,
            file_name: file_name.unwrap_or_else(|| "skin.png".into()),
            model_override: parse_model(&model),
        }
    };
    let job = mgr.start(input);
    let job_id = job.job_id.clone();
    tauri::async_runtime::spawn(watch_job(app, mgr, job_id));
    Ok(ImportAccepted { job_id: job.job_id })
}

#[tauri::command]
pub async fn skin_get_import(state: State<'_, SkinState>, job_id: String) -> CmdResult<ImportJob> {
    state
        .service
        .imports
        .get(&job_id)
        .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "job not found"))
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn skin_list_imports(state: State<'_, SkinState>) -> CmdResult<Vec<ImportJob>> {
    Ok(state.service.imports.list())
}

#[tauri::command]
pub async fn skin_cancel_import(
    state: State<'_, SkinState>,
    job_id: String,
) -> CmdResult<ImportJob> {
    state
        .service
        .imports
        .cancel(&job_id)
        .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "job not found"))
        .map_err(CommandError::from)
}

/// Binary preview PNG (avoid JSON number arrays). Cached PNG first, then
/// rebuilt from the object — never re-normalized.
#[tauri::command]
pub async fn skin_get_preview_png(
    state: State<'_, SkinState>,
    skin_id: String,
) -> CmdResult<Response> {
    if !skin_core::storage::is_valid_skin_id(&skin_id) {
        return Err(SkinError::api(codes::BAD_REQUEST, "bad skinId").into());
    }
    with_library(&state, move |lib| {
        if let Some(png) = lib.get_preview_png(&skin_id)? {
            return Ok(png);
        }
        let obj = lib
            .get_object(&skin_id)?
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "skin not found"))?;
        let (decoded, _) = decode_skin_code(&obj.0)?;
        let png = rgba_to_png(&decoded.rgba)?;
        lib.put_preview_png(&skin_id, &png)?;
        Ok(png)
    })
    .await
    .map(Response::new)
}

/// Export a skin: png (base64), hskin (text) or skin-json (portable v2).
#[tauri::command]
pub async fn skin_export_skin(
    state: State<'_, SkinState>,
    skin_id: String,
    format: String,
) -> CmdResult<serde_json::Value> {
    with_library(&state, move |lib| {
        let obj = lib
            .get_object(&skin_id)?
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "skin not found"))?;
        match format.as_str() {
            "hskin" => Ok(serde_json::json!({ "text": obj.0 })),
            "png" => {
                let (decoded, _) = decode_skin_code(&obj.0)?;
                let png = rgba_to_png(&decoded.rgba)?;
                Ok(serde_json::json!({
                    "pngBase64": b64_encode(&png),
                }))
            }
            "skin-json" => {
                // Metadata only when exactly one entry references the skin.
                let candidates = lib.entries_using(&skin_id);
                let entry =
                    if candidates.len() == 1 { candidates.into_iter().next() } else { None };
                let tag_paths: Vec<Vec<String>> = entry
                    .as_ref()
                    .map(|e| e.tags.iter().map(|name| vec![name.clone()]).collect())
                    .unwrap_or_default();
                let (name, model, active, license, provenance, note) = match entry {
                    Some(e) => (
                        e.name,
                        e.model,
                        e.active,
                        e.license,
                        e.provenance,
                        e.note,
                    ),
                    None => (
                        format!("skin-{}", &skin_id[..8]),
                        skin_core::codec::SkinModel::Classic,
                        false,
                        Default::default(),
                        Default::default(),
                        Default::default(),
                    ),
                };
                let portable = PortableSkinFileV3 {
                    schema_version: 3,
                    name,
                    skin_id: skin_id.clone(),
                    skin_code: obj.0,
                    model,
                    tag_paths,
                    active,
                    license,
                    provenance,
                    note,
                };
                Ok(serde_json::to_value(portable)?)
            }
            other => Err(SkinError::api(
                codes::BAD_REQUEST,
                format!("format must be png|hskin|skin-json, got {other}"),
            )),
        }
    })
    .await
}

/// Portable v3 export addressed by entryId (correct per-entry metadata).
#[tauri::command]
pub async fn skin_export_entry(
    state: State<'_, SkinState>,
    entry_id: String,
    format: Option<String>,
) -> CmdResult<serde_json::Value> {
    with_library(&state, move |lib| {
        let entry = lib
            .get_entry(&entry_id)
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "entry not found"))?;
        let obj = lib
            .get_object(&entry.skin_id)?
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "skin object missing"))?;
        let tag_paths: Vec<Vec<String>> = entry
            .tags
            .iter()
            .map(|name| vec![name.clone()])
            .collect();
        match format.as_deref() {
            Some("v2") => {
                let portable = PortableSkinFileV2 {
                    schema_version: 2,
                    name: entry.name.clone(),
                    tag_paths,
                    skin_id: entry.skin_id.clone(),
                    skin_code: obj.0,
                };
                Ok(serde_json::to_value(portable)?)
            }
            _ => {
                let portable = PortableSkinFileV3 {
                    schema_version: 3,
                    name: entry.name,
                    skin_id: entry.skin_id,
                    skin_code: obj.0,
                    model: entry.model,
                    tag_paths,
                    active: entry.active,
                    license: entry.license,
                    provenance: entry.provenance,
                    note: entry.note,
                };
                Ok(serde_json::to_value(portable)?)
            }
        }
    })
    .await
}

/// Export a manifest of all active entries (usable materials).
#[tauri::command]
pub async fn skin_export_usable_manifest(
    state: State<'_, SkinState>,
) -> CmdResult<serde_json::Value> {
    with_library(&state, move |lib| {
        let entries = lib.list_usable_entries();
        let items: Vec<serde_json::Value> = entries
            .into_iter()
            .map(|e| {
                serde_json::json!({
                    "entryId": e.entry_id,
                    "skinId": e.skin_id,
                    "name": e.name,
                    "model": e.model,
                    "author": e.provenance.author,
                    "license": e.license,
                    "provenance": e.provenance,
                })
            })
            .collect();
        Ok(serde_json::json!({ "entries": items, "count": items.len() }))
    })
    .await
}

/// Copy the hskin text for clipboard use.
#[tauri::command]
pub async fn skin_get_skin_code(
    state: State<'_, SkinState>,
    skin_id: String,
) -> CmdResult<String> {
    with_library(&state, move |lib| {
        lib.get_object(&skin_id)?
            .map(|(code, _)| code)
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "skin not found"))
    })
    .await
}

/// Save an export to a user-chosen path (chosen via the dialog plugin on the
/// frontend; this command only writes already-validated content).
#[tauri::command]
pub async fn skin_write_export_file(
    state: State<'_, SkinState>,
    path: String,
    skin_id: String,
    format: String,
) -> CmdResult<()> {
    with_library(&state, move |lib| {
        let obj = lib
            .get_object(&skin_id)?
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "skin not found"))?;
        let bytes: Vec<u8> = match format.as_str() {
            "hskin" => format!("{}\n", obj.0).into_bytes(),
            "png" => {
                let (decoded, _) = decode_skin_code(&obj.0)?;
                rgba_to_png(&decoded.rgba)?
            }
            other => {
                return Err(SkinError::api(
                    codes::BAD_REQUEST,
                    format!("format must be png|hskin, got {other}"),
                ));
            }
        };
        std::fs::write(&path, bytes)?;
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// Network helpers for FSA mode (storage stays in the project folder; only
// SSRF-guarded fetch / Mojang resolve go through Rust).
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPlayerDto {
    pub uuid: String,
    pub player_name: String,
    pub skin_url: String,
    pub model: String,
}

#[tauri::command]
pub async fn skin_net_fetch_png(url: String) -> CmdResult<String> {
    let fetched = skin_core::network::safe_fetch(&url).await?;
    Ok(b64_encode(&fetched.body))
}

#[tauri::command]
pub async fn skin_net_resolve_player(name: String) -> CmdResult<ResolvedPlayerDto> {
    let r = skin_core::network::player::resolve_player_skin(&name).await?;
    Ok(ResolvedPlayerDto {
        uuid: r.uuid,
        player_name: r.player_name,
        skin_url: r.skin_url,
        model: match r.model {
            SkinModel::Slim => "slim".into(),
            SkinModel::Classic => "classic".into(),
        },
    })
}
