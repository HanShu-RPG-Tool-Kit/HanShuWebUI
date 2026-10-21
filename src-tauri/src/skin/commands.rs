//! Native read-only network helpers. All project/library mutations go through project-server.
use skin_core::codec::SkinModel;
use skin_core::SkinError;
fn b64_encode(data: &[u8]) -> String {
    skin_core::codec::base64_standard(data)
}
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
