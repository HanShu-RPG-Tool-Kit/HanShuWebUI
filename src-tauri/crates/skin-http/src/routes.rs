//! HTTP routes mirroring the Tauri command surface. All JSON is camelCase;
//! errors carry the same stable `code` + `message` shape.

use super::AppState;
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use skin_core::codec::{decode_skin_code, SkinModel};
use skin_core::error::{codes, SkinError};
use skin_core::imports::ImportInput;
use skin_core::normalize::rgba_to_png;
use skin_core::storage::schema::{LibraryEntry, PortableSkinFileV2, PortableSkinFileV3};
use skin_core::storage::{
    BatchPatch, LibraryQuery, PatchEntry, PatchFolder, PatchTag,
};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
}

impl From<SkinError> for ApiError {
    fn from(e: SkinError) -> Self {
        ApiError {
            code: e.code().to_string(),
            message: e.to_string(),
            retry_after_ms: e.retry_after_ms(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.code.as_str() {
            codes::NOT_FOUND => StatusCode::NOT_FOUND,
            codes::BAD_REQUEST | codes::FORMAT_ERROR => StatusCode::BAD_REQUEST,
            codes::CONFLICT | codes::REVISION_MISMATCH => StatusCode::CONFLICT,
            codes::PAYLOAD_TOO_LARGE => StatusCode::PAYLOAD_TOO_LARGE,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self)).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    tool_version: String,
    api_version: String,
    library_schema_version: u32,
    format_version: u32,
    import_kinds: [&'static str; 5],
    live_apply: bool,
    features: CapabilitiesFeatures,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesFeatures {
    batch_active: bool,
    http_api: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TagTreeResponse {
    revision: u64,
    tags: Vec<skin_core::storage::TagWithStats>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderTreeResponse {
    revision: u64,
    folders: Vec<skin_core::storage::FolderWithStats>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateNodeRequest {
    name: String,
    parent_id: Option<String>,
    #[serde(default)]
    expected_revision: Option<u64>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveEntryRequest {
    job_id: String,
    name: String,
    #[serde(default)]
    tag_ids: Vec<String>,
    #[serde(default)]
    tag_paths: Vec<Vec<String>>,
    folder_id: Option<String>,
    #[serde(default)]
    favorite: bool,
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    license: Option<skin_core::storage::schema::LicenseInfo>,
    #[serde(default)]
    provenance: Option<skin_core::storage::schema::Provenance>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartImportRequest {
    kind: String,
    text: Option<String>,
    #[serde(default)]
    model: Option<String>,
    file_name: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportAccepted {
    job_id: String,
}

#[derive(Debug, Deserialize)]
struct ExportQuery {
    format: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeleteTagQuery {
    branch: Option<bool>,
    expected_revision: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct PatchEntryQuery {
    expected_revision: Option<u64>,
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

async fn with_library<T, F>(state: &AppState, f: F) -> ApiResult<T>
where
    T: Send + 'static,
    F: FnOnce(Arc<skin_core::storage::Storage>) -> Result<T, SkinError> + Send + 'static,
{
    let library = state.library.clone();
    tokio::task::spawn_blocking(move || f(library))
        .await
        .map_err(|e| SkinError::api(codes::INTERNAL, format!("blocking task failed: {e}")))?
        .map_err(ApiError::from)
}

fn _err_response(e: ApiError) -> Response {
    e.into_response()
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/capabilities", get(get_capabilities))
        .route("/entries/query", post(list_entries))
        .route("/entries/save", post(save_entry))
        .route("/entries/{entry_id}", get(get_entry).patch(patch_entry).delete(delete_entry))
        .route("/entries:batch", post(batch_patch_entries))
        .route("/tags", get(list_tags).post(create_tag))
        .route("/tags/{tag_id}", patch(patch_tag).delete(delete_tag))
        .route("/folders", get(list_folders).post(create_folder))
        .route("/folders/{folder_id}", patch(patch_folder).delete(delete_folder))
        .route("/imports", get(list_imports).post(start_import))
        .route("/imports/upload", post(upload_import))
        .route("/imports/{job_id}", get(get_import))
        .route("/imports/{job_id}/cancel", post(cancel_import))
        .route("/skins/{skin_id}/preview.png", get(get_preview_png))
        .route("/skins/{skin_id}/code", get(get_skin_code))
        .route("/skins/{skin_id}/export", get(export_skin))
        .route("/entries/{entry_id}/export", get(export_entry))
        .route("/usable-manifest", get(export_usable_manifest))
        .route("/events", get(sse_events))
        .layer(DefaultBodyLimit::max(1024 * 1024 * 64)) // 64 MiB
        .with_state(state)
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async fn get_capabilities() -> Json<Capabilities> {
    Json(Capabilities {
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: "1.0.0".to_string(),
        library_schema_version: skin_core::storage::schema::SCHEMA_VERSION,
        format_version: 1,
        import_kinds: ["png-file", "png-url", "player-name", "skin-code", "skin-file"],
        live_apply: false,
        features: CapabilitiesFeatures {
            batch_active: true,
            http_api: true,
        },
    })
}

async fn list_entries(
    State(state): State<AppState>,
    Json(query): Json<LibraryQuery>,
) -> ApiResult<Json<skin_core::storage::LibraryPage>> {
    let page = with_library(&state, move |lib| Ok(lib.list_entries(&query))).await?;
    Ok(Json(page))
}

async fn get_entry(
    State(state): State<AppState>,
    Path(entry_id): Path<String>,
) -> ApiResult<Json<LibraryEntry>> {
    let entry = with_library(&state, move |lib| {
        lib.get_entry(&entry_id)
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "entry not found"))
    })
    .await?;
    Ok(Json(entry))
}

async fn list_tags(State(state): State<AppState>) -> ApiResult<Json<TagTreeResponse>> {
    let (revision, tags) = with_library(&state, move |lib| Ok(lib.tag_tree_with_stats())).await?;
    Ok(Json(TagTreeResponse { revision, tags }))
}

async fn create_tag(
    State(state): State<AppState>,
    Json(body): Json<CreateNodeRequest>,
) -> ApiResult<Json<skin_core::storage::schema::TagNode>> {
    let out = with_library(&state, move |lib| {
        lib.create_tag(&body.name, body.parent_id, body.expected_revision)
    })
    .await?;
    Ok(Json(out))
}

async fn patch_tag(
    State(state): State<AppState>,
    Path(tag_id): Path<String>,
    Json(patch): Json<PatchTag>,
) -> ApiResult<Json<skin_core::storage::schema::TagNode>> {
    let out = with_library(&state, move |lib| lib.patch_tag(&tag_id, patch)).await?;
    Ok(Json(out))
}

async fn delete_tag(
    State(state): State<AppState>,
    Path(tag_id): Path<String>,
    Query(q): Query<DeleteTagQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let out = with_library(&state, move |lib| {
        let (removed, affected) = lib.delete_tag(&tag_id, q.branch.unwrap_or(false), q.expected_revision)?;
        Ok(serde_json::json!({
            "removedTagIds": removed,
            "affectedEntries": affected,
        }))
    })
    .await?;
    Ok(Json(out))
}

async fn list_folders(State(state): State<AppState>) -> ApiResult<Json<FolderTreeResponse>> {
    let (revision, folders) = with_library(&state, move |lib| Ok(lib.folder_tree_with_stats())).await?;
    Ok(Json(FolderTreeResponse { revision, folders }))
}

async fn create_folder(
    State(state): State<AppState>,
    Json(body): Json<CreateNodeRequest>,
) -> ApiResult<Json<skin_core::storage::schema::FolderNode>> {
    let out = with_library(&state, move |lib| lib.create_folder(&body.name, body.parent_id)).await?;
    Ok(Json(out))
}

async fn patch_folder(
    State(state): State<AppState>,
    Path(folder_id): Path<String>,
    Json(patch): Json<PatchFolder>,
) -> ApiResult<Json<skin_core::storage::schema::FolderNode>> {
    let out = with_library(&state, move |lib| lib.patch_folder(&folder_id, patch)).await?;
    Ok(Json(out))
}

async fn delete_folder(
    State(state): State<AppState>,
    Path(folder_id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let out = with_library(&state, move |lib| {
        lib.delete_folder(&folder_id)?;
        Ok(serde_json::json!({ "deleted": true }))
    })
    .await?;
    Ok(Json(out))
}

async fn save_entry(
    State(state): State<AppState>,
    Json(body): Json<SaveEntryRequest>,
) -> ApiResult<Json<LibraryEntry>> {
    let imports = state.imports.clone();
    let out = tokio::task::spawn_blocking(move || {
        imports.save_entry(
            &body.job_id,
            &body.name,
            body.tag_ids,
            body.tag_paths,
            body.folder_id,
            body.favorite,
            body.active,
            body.license,
            body.provenance,
            body.note,
        )
    })
    .await
    .map_err(|e| SkinError::api(codes::INTERNAL, e.to_string()))??;
    Ok(Json(out))
}

async fn patch_entry(
    State(state): State<AppState>,
    Path(entry_id): Path<String>,
    Query(query): Query<PatchEntryQuery>,
    Json(patch): Json<PatchEntry>,
) -> ApiResult<Json<LibraryEntry>> {
    let out = with_library(&state, move |lib| {
        // The HTTP API expects `expectedRevision` as a query parameter.
        let revision = query.expected_revision.ok_or_else(|| {
            SkinError::api(codes::BAD_REQUEST, "expectedRevision required")
        })?;
        lib.patch_entry(&entry_id, revision, patch)
    })
    .await?;
    Ok(Json(out))
}

async fn batch_patch_entries(
    State(state): State<AppState>,
    Json(batch): Json<BatchPatch>,
) -> ApiResult<Json<serde_json::Value>> {
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
    Ok(Json(out))
}

async fn delete_entry(
    State(state): State<AppState>,
    Path(entry_id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let out = with_library(&state, move |lib| {
        let ok = lib.remove_entry(&entry_id)?;
        if !ok {
            return Err(SkinError::api(codes::NOT_FOUND, "entry not found"));
        }
        Ok(serde_json::json!({ "deleted": true }))
    })
    .await?;
    Ok(Json(out))
}

async fn list_imports(State(state): State<AppState>) -> Json<Vec<skin_core::imports::ImportJob>> {
    Json(state.imports.list())
}

async fn get_import(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> ApiResult<Json<skin_core::imports::ImportJob>> {
    state
        .imports
        .get(&job_id)
        .map(Json)
        .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "job not found").into())
}

async fn cancel_import(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> ApiResult<Json<skin_core::imports::ImportJob>> {
    state
        .imports
        .cancel(&job_id)
        .map(Json)
        .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "job not found").into())
}

async fn start_import(
    State(state): State<AppState>,
    Json(body): Json<StartImportRequest>,
) -> ApiResult<Json<ImportAccepted>> {
    let mgr = state.imports.clone();
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
            return Err(SkinError::api(codes::BAD_REQUEST, format!("unknown kind {other}")).into());
        }
    };
    let job = mgr.start(input);
    Ok(Json(ImportAccepted { job_id: job.job_id }))
}

/// Multipart file upload for browser imports.
async fn upload_import(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> ApiResult<Json<ImportAccepted>> {
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut file_name: Option<String> = None;
    let mut model: Option<String> = None;
    while let Some(field) = multipart.next_field().await.map_err(|e| {
        SkinError::api(codes::BAD_REQUEST, format!("multipart error: {e}"))
    })? {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" {
            file_name = field.file_name().map(|s| s.to_string());
            let data = field.bytes().await.map_err(|e| {
                SkinError::api(codes::BAD_REQUEST, format!("failed to read file: {e}"))
            })?;
            file_bytes = Some(data.to_vec());
        } else if name == "model" {
            let text = field.text().await.map_err(|e| {
                SkinError::api(codes::BAD_REQUEST, format!("failed to read model: {e}"))
            })?;
            model = Some(text);
        }
    }
    let bytes = file_bytes.ok_or_else(|| SkinError::api(codes::BAD_REQUEST, "file field required"))?;
    let file_name = file_name.unwrap_or_else(|| "skin.png".into());
    let is_portable = file_name.to_lowercase().ends_with(".skin.json");
    let cap = if is_portable {
        skin_core::codec::limits::PORTABLE_JSON_BYTES
    } else {
        skin_core::codec::limits::PNG_BYTES
    };
    if bytes.len() > cap {
        return Err(SkinError::api(
            codes::PAYLOAD_TOO_LARGE,
            format!("file exceeds {cap} bytes"),
        )
        .into());
    }
    let input = if is_portable {
        ImportInput::SkinFile {
            bytes,
            file_name: Some(file_name),
        }
    } else {
        ImportInput::PngFile {
            bytes,
            file_name,
            model_override: parse_model(&model),
        }
    };
    let job = state.imports.start(input);
    Ok(Json(ImportAccepted { job_id: job.job_id }))
}

async fn get_preview_png(
    State(state): State<AppState>,
    Path(skin_id): Path<String>,
) -> ApiResult<Response> {
    if !skin_core::storage::is_valid_skin_id(&skin_id) {
        return Err(SkinError::api(codes::BAD_REQUEST, "bad skinId").into());
    }
    let png = with_library(&state, move |lib| {
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
    .await?;
    Ok((
        [(header::CONTENT_TYPE, "image/png")],
        png,
    )
        .into_response())
}

async fn get_skin_code(
    State(state): State<AppState>,
    Path(skin_id): Path<String>,
) -> ApiResult<String> {
    let code = with_library(&state, move |lib| {
        lib.get_object(&skin_id)?
            .map(|(code, _)| code)
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "skin not found"))
    })
    .await?;
    Ok(code)
}

async fn export_skin(
    State(state): State<AppState>,
    Path(skin_id): Path<String>,
    Query(q): Query<ExportQuery>,
) -> ApiResult<Response> {
    let format = q.format.clone().unwrap_or_else(|| "skin-json".to_string());
    let skin_id_for_closure = skin_id.clone();
    let format_for_closure = format.clone();
    let (content_type, body): (&'static str, Vec<u8>) = with_library(&state, move |lib| {
        let obj = lib
            .get_object(&skin_id_for_closure)?
            .ok_or_else(|| SkinError::api(codes::NOT_FOUND, "skin not found"))?;
        match format_for_closure.as_str() {
            "hskin" => Ok(("text/plain", format!("{}\n", obj.0).into_bytes())),
            "png" => {
                let (decoded, _) = decode_skin_code(&obj.0)?;
                let png = rgba_to_png(&decoded.rgba)?;
                Ok(("image/png", png))
            }
            "skin-json" => {
                let candidates = lib.entries_using(&skin_id_for_closure);
                let entry = if candidates.len() == 1 {
                    candidates.into_iter().next()
                } else {
                    None
                };
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
                        .unwrap_or_else(|| format!("skin-{}", &skin_id_for_closure[..8])),
                    tag_paths,
                    skin_id: skin_id_for_closure.clone(),
                    skin_code: obj.0,
                };
                let json = serde_json::to_vec(&portable)?;
                Ok(("application/json", json))
            }
            other => Err(SkinError::api(
                codes::BAD_REQUEST,
                format!("format must be png|hskin|skin-json, got {other}"),
            )),
        }
    })
    .await?;
    let ext = format.replace('-', ".");
    let disposition = format!("attachment; filename=\"{}.{}\"", &skin_id[..12], ext);
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, disposition.as_str()),
        ],
        body,
    )
        .into_response())
}

async fn export_entry(
    State(state): State<AppState>,
    Path(entry_id): Path<String>,
    Query(q): Query<ExportQuery>,
) -> ApiResult<Response> {
    let format = q.format.clone().unwrap_or_else(|| "v3".to_string());
    let entry_id_for_closure = entry_id.clone();
    let format_for_closure = format.clone();
    let (content_type, body): (&'static str, Vec<u8>) = with_library(&state, move |lib| {
        let entry = lib
            .get_entry(&entry_id_for_closure)
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
        match format_for_closure.as_str() {
            "v2" => {
                let portable = PortableSkinFileV2 {
                    schema_version: 2,
                    name: entry.name,
                    tag_paths,
                    skin_id: entry.skin_id,
                    skin_code: obj.0,
                };
                Ok(("application/json", serde_json::to_vec(&portable)?))
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
                Ok(("application/json", serde_json::to_vec(&portable)?))
            }
        }
    })
    .await?;
    let disposition = format!("attachment; filename=\"{}.skin.json\"", &entry_id[..8]);
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_DISPOSITION, disposition.as_str()),
        ],
        body,
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// SSE events
// ---------------------------------------------------------------------------

/// Manifest of all active entries (usable materials) — same shape as the
/// Tauri `skin_export_usable_manifest` command.
async fn export_usable_manifest(
    State(state): State<AppState>,
) -> ApiResult<Json<serde_json::Value>> {
    let entries = with_library(&state, move |lib| Ok(lib.list_usable_entries())).await?;
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
    Ok(Json(serde_json::json!({ "entries": items, "count": items.len() })))
}

async fn sse_events(
    State(state): State<AppState>,
) -> Response {
    let imports = state.imports.clone();
    let library = state.library.clone();

    // Emit only on change: track the last-seen revision and per-job seq so a
    // quiet library does not produce a stream of identical events.
    let stream = stream::unfold(
        (imports, library, 0u64, HashMap::<String, u64>::new(), tokio::time::interval(Duration::from_millis(500))),
        |(imports, library, mut last_rev, mut last_seq, mut interval)| async move {
            interval.tick().await;
            let jobs = imports.list();
            let revision = library.revision();
            let mut events: Vec<Result<axum::response::sse::Event, Infallible>> = Vec::new();
            for job in jobs {
                let seq = last_seq.get(&job.job_id).copied().unwrap_or(0);
                if job.seq > seq {
                    last_seq.insert(job.job_id.clone(), job.seq);
                    events.push(Ok(
                        axum::response::sse::Event::default()
                            .event("job-updated")
                            .json_data(serde_json::json!({
                                "jobId": job.job_id,
                                "seq": job.seq,
                                "state": job.state,
                            }))
                            .unwrap(),
                    ));
                }
            }
            if revision != last_rev {
                last_rev = revision;
                events.push(Ok(
                    axum::response::sse::Event::default()
                        .event("library-updated")
                        .json_data(serde_json::json!({
                            "revision": revision,
                            "domain": "entries",
                        }))
                        .unwrap(),
                ));
            }
            if events.is_empty() {
                // Keep the connection alive without spamming duplicate data.
                events.push(Ok(
                    axum::response::sse::Event::default().comment("keep-alive"),
                ));
            }
            Some((events, (imports, library, last_rev, last_seq, interval)))
        },
    )
    .flat_map(stream::iter);

    axum::response::sse::Sse::new(stream)
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(Duration::from_secs(25))
                .text("keep-alive"),
        )
        .into_response()
}
