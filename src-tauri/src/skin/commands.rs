//! IPC commands: thin adapters over skin-core. DTOs use camelCase JSON;
//! errors carry a stable `code` + `message` (+ optional `retryAfterMs`).
//! Library calls that may wait on the write lock run in spawn_blocking.

use super::events;
use super::state::SkinState;
use skin_core::codec::{decode_skin_code, SkinModel};
use skin_core::error::codes;
use skin_core::imports::{ImportInput, ImportJob, JobState};
use skin_core::normalize::rgba_to_png;
use skin_core::storage::schema::{LibraryEntry, PortableSkinFileV2};
use skin_core::storage::{
    BatchPatch, LibraryQuery, PatchEntry, PatchFolder, PatchTag, Storage,
};
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
    pub format_version: u32,
    pub import_kinds: [&'static str; 5],
    pub live_apply: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagTreeResponse {
    pub revision: u64,
    pub tags: Vec<skin_core::storage::TagWithStats>,
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
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub tag_paths: Vec<Vec<String>>,
    pub folder_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
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
        format_version: 1,
        import_kinds: ["png-file", "png-url", "player-name", "skin-code", "skin-file"],
        live_apply: false,
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
pub async fn skin_list_tags(state: State<'_, SkinState>) -> CmdResult<TagTreeResponse> {
    with_library(&state, move |lib| {
        let (revision, tags) = lib.tag_tree_with_stats();
        Ok(TagTreeResponse { revision, tags })
    })
    .await
}

#[tauri::command]
pub async fn skin_create_tag(
    app: AppHandle,
    state: State<'_, SkinState>,
    body: CreateNodeRequest,
) -> CmdResult<skin_core::storage::schema::TagNode> {
    let out = with_library(&state, move |lib| {
        lib.create_tag(&body.name, body.parent_id, body.expected_revision)
    })
    .await?;
    events::emit_library_updated(&app, &state, "tags");
    Ok(out)
}

#[tauri::command]
pub async fn skin_patch_tag(
    app: AppHandle,
    state: State<'_, SkinState>,
    tag_id: String,
    patch: PatchTag,
) -> CmdResult<skin_core::storage::schema::TagNode> {
    let out = with_library(&state, move |lib| lib.patch_tag(&tag_id, patch)).await?;
    events::emit_library_updated(&app, &state, "tags");
    Ok(out)
}

#[tauri::command]
pub async fn skin_delete_tag(
    app: AppHandle,
    state: State<'_, SkinState>,
    tag_id: String,
    branch: bool,
    expected_revision: Option<u64>,
) -> CmdResult<serde_json::Value> {
    let out = with_library(&state, move |lib| {
        let (removed, affected) = lib.delete_tag(&tag_id, branch, expected_revision)?;
        Ok(serde_json::json!({
            "removedTagIds": removed,
            "affectedEntries": affected,
        }))
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
                body.tag_ids,
                body.tag_paths,
                body.folder_id,
                body.favorite,
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
        patch.tag_ids.is_some() || patch.add_tag_ids.is_some() || patch.remove_tag_ids.is_some();
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
                    .map(|e| {
                        e.tag_ids
                            .iter()
                            .map(|id| lib.tag_path(id))
                            .filter(|p| !p.is_empty())
                            .collect()
                    })
                    .unwrap_or_default();
                let portable = PortableSkinFileV2 {
                    schema_version: 2,
                    name: entry
                        .map(|e| e.name)
                        .unwrap_or_else(|| format!("skin-{}", &skin_id[..8])),
                    tag_paths,
                    skin_id: skin_id.clone(),
                    skin_code: obj.0,
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

/// Portable v2 export addressed by entryId (correct per-entry metadata).
#[tauri::command]
pub async fn skin_export_entry(
    state: State<'_, SkinState>,
    entry_id: String,
) -> CmdResult<serde_json::Value> {
    with_library(&state, move |lib| {
        let entry = lib
            .get_entry(&entry_id)
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "entry not found"))?;
        let obj = lib
            .get_object(&entry.skin_id)?
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "skin object missing"))?;
        let tag_paths: Vec<Vec<String>> = entry
            .tag_ids
            .iter()
            .map(|id| lib.tag_path(id))
            .filter(|p| !p.is_empty())
            .collect();
        let portable = PortableSkinFileV2 {
            schema_version: 2,
            name: entry.name,
            tag_paths,
            skin_id: entry.skin_id,
            skin_code: obj.0,
        };
        Ok(serde_json::to_value(portable)?)
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
