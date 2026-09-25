//! Java player-name → skin resolution (port of `service/src/playerProvider.ts`).
//!
//! Two fixed endpoints (no caller-supplied base URLs):
//!   1. name → UUID:   https://api.minecraftservices.com/minecraft/profile/lookup/name/<name>
//!   2. UUID → profile: https://sessionserver.mojang.com/session/minecraft/profile/<uuid>?unsigned=false
//!
//! The textures property is standard Base64 (NOT the URL-safe hskin engine).
//! Distinct error codes: not-found, rate-limited (429 + Retry-After),
//! unavailable, no custom skin. 60s success cache.

use super::safe_fetch;
use crate::codec::SkinModel;
use crate::error::{codes, SkinError, SkinResult};
use base64::engine::general_purpose::STANDARD as B64_STANDARD;
use base64::Engine;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const NAME_LOOKUP: &str = "https://api.minecraftservices.com/minecraft/profile/lookup/name/";
const SESSION_PROFILE: &str = "https://sessionserver.mojang.com/session/minecraft/profile/";
const CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct ResolvedPlayerSkin {
    pub uuid: String,
    pub player_name: String,
    pub skin_url: String,
    pub model: SkinModel,
}

struct CacheEntry {
    value: ResolvedPlayerSkin,
    expires_at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, CacheEntry>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn fetch_json(url: &str) -> SkinResult<serde_json::Value> {
    let res = match safe_fetch(url).await {
        Ok(r) => r,
        Err(e) if e.code() == codes::FETCH_FAILED => {
            return Err(SkinError::api(
                codes::PLAYER_SERVICE_UNAVAILABLE,
                format!("profile service unreachable: {}", e.to_string().trim()),
            ));
        }
        Err(e) => {
            return Err(SkinError::api(
                codes::FETCH_FAILED,
                e.to_string().trim().to_string(),
            ));
        }
    };
    serde_json::from_slice(&res.body)
        .map_err(|_| SkinError::api(codes::PLAYER_SERVICE_UNAVAILABLE, "profile response not JSON"))
}

/// Resolve a Java player name to their current skin URL + model.
pub async fn resolve_player_skin(player_name: &str) -> SkinResult<ResolvedPlayerSkin> {
    let key = player_name.to_lowercase();
    {
        let cache = cache().lock().unwrap();
        if let Some(hit) = cache.get(&key) {
            if hit.expires_at > Instant::now() {
                return Ok(hit.value.clone());
            }
        }
    }

    // Step 1: name → UUID
    let name_url = format!("{NAME_LOOKUP}{}", urlencode(player_name));
    let name_res = fetch_json(&name_url).await?;
    let uuid = name_res
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            SkinError::api(
                codes::PLAYER_NOT_FOUND,
                format!("no such player: {player_name}"),
            )
        })?
        .to_string();
    let canonical_name = name_res
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(player_name)
        .to_string();

    // Step 2: UUID → session profile with textures property
    let profile_url = format!("{SESSION_PROFILE}{uuid}?unsigned=false");
    let profile = fetch_json(&profile_url).await?;
    let tex_prop = profile
        .get("properties")
        .and_then(|p| p.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|p| p.get("name").and_then(|n| n.as_str()) == Some("textures"))
        })
        .and_then(|p| p.get("value").and_then(|v| v.as_str()))
        .ok_or_else(|| {
            SkinError::api(codes::PLAYER_NO_SKIN, "profile has no textures property")
        })?;
    // Standard Base64 — not the URL-safe no-pad hskin engine.
    let decoded = B64_STANDARD
        .decode(tex_prop)
        .map_err(|_| SkinError::api(codes::PLAYER_SERVICE_UNAVAILABLE, "textures value not decodable"))?;
    let tex: serde_json::Value = serde_json::from_slice(&decoded)
        .map_err(|_| SkinError::api(codes::PLAYER_SERVICE_UNAVAILABLE, "textures value not decodable"))?;
    let skin = tex
        .pointer("/textures/SKIN")
        .ok_or_else(|| SkinError::api(codes::PLAYER_NO_SKIN, "player has no custom skin"))?;
    let skin_url = skin
        .get("url")
        .and_then(|u| u.as_str())
        .ok_or_else(|| SkinError::api(codes::PLAYER_NO_SKIN, "player has no custom skin"))?
        .to_string();
    // Player skin sources are restricted to the expected texture host.
    if let Ok(u) = url::Url::parse(&skin_url) {
        if u.host_str() != Some("textures.minecraft.net") {
            return Err(SkinError::api(
                codes::PLAYER_NO_SKIN,
                format!("unexpected skin host: {}", u.host_str().unwrap_or("?")),
            ));
        }
    } else {
        return Err(SkinError::api(codes::PLAYER_NO_SKIN, "skin URL invalid"));
    }
    let model = skin
        .pointer("/metadata/model")
        .and_then(|m| m.as_str())
        .map(|m| if m == "slim" { SkinModel::Slim } else { SkinModel::Classic })
        .unwrap_or(SkinModel::Classic);

    let value = ResolvedPlayerSkin {
        uuid,
        player_name: canonical_name,
        skin_url,
        model,
    };
    cache().lock().unwrap().insert(
        key,
        CacheEntry { value: value.clone(), expires_at: Instant::now() + CACHE_TTL },
    );
    Ok(value)
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Parse Retry-After (seconds or HTTP-date) into a bounded backoff.
pub fn parse_retry_after(value: &str, now: SystemTime) -> Option<u64> {
    let trimmed = value.trim();
    if let Ok(secs) = trimmed.parse::<u64>() {
        return Some(secs.min(300));
    }
    if let Some(t) = httpdate_parse(trimmed) {
        let delta = t.duration_since(now).ok()?.as_secs();
        return Some(delta.min(300));
    }
    None
}

/// Minimal RFC 7231 IMF-fixdate parser: "Sun, 06 Nov 1994 08:49:37 GMT".
fn httpdate_parse(s: &str) -> Option<SystemTime> {
    let s = s.trim().trim_end_matches(" GMT");
    // "Sun, 06 Nov 1994 08:49:37" → day "06", month "Nov", year "1994"
    let (date_str, time_part) = s.rsplit_once(' ')?;
    let day_str = date_str.split(", ").nth(1)?;
    let mut fields = day_str.split(' ');
    let day: u32 = fields.next()?.parse().ok()?;
    let month = match fields.next()? {
        "Jan" => 1, "Feb" => 2, "Mar" => 3, "Apr" => 4, "May" => 5, "Jun" => 6,
        "Jul" => 7, "Aug" => 8, "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    let year: i64 = fields.next()?.parse().ok()?;
    let mut time_fields = time_part.split(':');
    let h: u64 = time_fields.next()?.parse().ok()?;
    let m: u64 = time_fields.next()?.parse().ok()?;
    let sec: u64 = time_fields.next()?.parse().ok()?;
    // days since epoch (Howard Hinnant's days_from_civil)
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days as u64 * 86_400 + h * 3600 + m * 60 + sec;
    Some(UNIX_EPOCH + Duration::from_secs(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_seconds() {
        assert_eq!(parse_retry_after("30", SystemTime::now()), Some(30));
        assert_eq!(parse_retry_after("99999", SystemTime::now()), Some(300));
        assert_eq!(parse_retry_after("junk", SystemTime::now()), None);
    }

    #[test]
    fn retry_after_http_date() {
        let now = UNIX_EPOCH + Duration::from_secs(784_111_777); // 1994-11-06T08:49:37Z
        let t = parse_retry_after("Sun, 06 Nov 1994 08:50:37 GMT", now);
        assert_eq!(t, Some(60));
    }

    #[tokio::test]
    async fn rejects_invalid_player_name() {
        // A name with a slash cannot be a valid player name; the endpoint 404s
        // or the URL fails to parse — either way we must not panic.
        let res = resolve_player_skin("../etc/passwd").await;
        assert!(res.is_err());
    }
}
