//! SSRF-guarded URL fetch (port of `service/src/safeFetch.ts`, hardened per
//! the migration review):
//!   - http/https only; textures.minecraft.net http→https upgrade (exact host)
//!   - per-hop DNS re-resolution + IP policy on ALL resolved addresses
//!     (any forbidden result rejects the whole hop)
//!   - connection pinned to a validated address via `resolve_to_addrs`
//!   - no client-side redirects; manual hop handling, max 3, re-validated
//!   - `no_proxy()` so system/env proxies cannot re-resolve behind our back
//!   - `Accept-Encoding: identity` and rejection of non-identity responses
//!   - bounded response body; Content-Length only for early rejection
//!   - separate DNS/connect/read timeouts and an overall deadline

pub mod ip_policy;
pub mod player;

use crate::codec::limits;
use crate::error::{codes, SkinError, SkinResult};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use url::Url;

pub const MAX_REDIRECTS: usize = 3;
pub const DNS_TIMEOUT: Duration = Duration::from_secs(5);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_BYTES: usize = limits::PNG_BYTES;
pub const USER_AGENT: &str = "HanShuWebUI-skin-manager/0.1 (+desktop tool)";

/// Only textures.minecraft.net is upgraded http→https.
fn upgrade_known_host(mut u: Url) -> Url {
    if u.scheme() == "http" && u.host_str() == Some("textures.minecraft.net") {
        let _ = u.set_scheme("https");
    }
    u
}

/// Validate scheme, userinfo, port. First version allows only 80/443 (and
/// no explicit port) — a deliberate, documented tightening vs the old tool.
fn validate_url(u: &Url) -> SkinResult<()> {
    if !matches!(u.scheme(), "http" | "https") {
        return Err(SkinError::api(
            codes::FETCH_FAILED,
            format!("protocol {} not allowed", u.scheme()),
        ));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(SkinError::api(codes::FETCH_FAILED, "URL credentials not allowed"));
    }
    if let Some(port) = u.port() {
        let default = if u.scheme() == "https" { 443 } else { 80 };
        if port != default {
            return Err(SkinError::api(
                codes::FETCH_FAILED,
                format!("non-standard port {port} not allowed"),
            ));
        }
    }
    Ok(())
}

/// Resolve a host and validate every address (conservative: any forbidden
/// result rejects the hop). Returns the validated addresses for pinning.
async fn resolve_and_validate(host: &str) -> SkinResult<Vec<SocketAddr>> {
    let fut = tokio::net::lookup_host((host, 0));
    let addrs = match tokio::time::timeout(DNS_TIMEOUT, fut).await {
        Ok(Ok(addrs)) => addrs.collect::<Vec<_>>(),
        Ok(Err(e)) => {
            return Err(SkinError::api(
                codes::FETCH_FAILED,
                format!("DNS lookup failed: {e}"),
            ));
        }
        Err(_) => {
            return Err(SkinError::api(codes::FETCH_TIMEOUT, "DNS lookup timed out"));
        }
    };
    if addrs.is_empty() {
        return Err(SkinError::api(codes::FETCH_FAILED, "DNS returned no addresses"));
    }
    for a in &addrs {
        if ip_policy::is_forbidden_ip(a.ip()) {
            return Err(SkinError::api(
                codes::FETCH_FORBIDDEN_ADDRESS,
                format!("address {} for {} is not allowed", a.ip(), host),
            ));
        }
    }
    Ok(addrs)
}

#[derive(Debug)]
pub struct Fetched {
    pub body: Vec<u8>,
    pub content_type: String,
    pub final_url: Url,
}

/// Fetch a URL with SSRF guards; follows at most MAX_REDIRECTS hops manually,
/// re-validating URL, DNS and IP at every hop.
pub async fn safe_fetch(raw_url: &str) -> SkinResult<Fetched> {
    let mut current = upgrade_known_host(
        Url::parse(raw_url)
            .map_err(|_| SkinError::api(codes::FETCH_FAILED, "invalid URL"))?,
    );
    let deadline = tokio::time::Instant::now() + TOTAL_TIMEOUT;

    for redirects_left in (0..=MAX_REDIRECTS).rev() {
        if tokio::time::Instant::now() >= deadline {
            return Err(SkinError::api(codes::FETCH_TIMEOUT, "total deadline exceeded"));
        }
        validate_url(&current)?;
        // url::Host gives us the parsed host: domain, IPv4 or IPv6 (no brackets).
        let host_parsed = current
            .host()
            .ok_or_else(|| SkinError::api(codes::FETCH_FAILED, "URL has no host"))?;
        let host = host_parsed.to_string();
        let port = current.port_or_known_default().unwrap_or(80);

        // IP literals bypass DNS but still go through the policy.
        let addrs: Vec<SocketAddr> = match host_parsed {
            url::Host::Domain(_) => resolve_and_validate(&host)
                .await?
                .into_iter()
                .map(|mut a| {
                    a.set_port(port);
                    a
                })
                .collect(),
            url::Host::Ipv4(ip) => {
                if ip_policy::is_forbidden_ip(IpAddr::V4(ip)) {
                    return Err(SkinError::api(
                        codes::FETCH_FORBIDDEN_ADDRESS,
                        format!("address {ip} is not allowed"),
                    ));
                }
                vec![SocketAddr::new(IpAddr::V4(ip), port)]
            }
            url::Host::Ipv6(ip) => {
                if ip_policy::is_forbidden_ip(IpAddr::V6(ip)) {
                    return Err(SkinError::api(
                        codes::FETCH_FORBIDDEN_ADDRESS,
                        format!("address {ip} is not allowed"),
                    ));
                }
                vec![SocketAddr::new(IpAddr::V6(ip), port)]
            }
        };

        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(deadline.saturating_duration_since(tokio::time::Instant::now()))
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .resolve_to_addrs(&host, &addrs)
            .build()
            .map_err(|e| {
                SkinError::api(codes::FETCH_FAILED, format!("client build failed: {e}"))
            })?;

        let resp = client
            .get(current.clone())
            .header("user-agent", USER_AGENT)
            .header("accept", "image/png,image/*;q=0.8,*/*;q=0.5")
            .header("accept-encoding", "identity")
            .send()
            .await
            .map_err(map_reqwest_err)?;

        let status = resp.status();
        if status.is_redirection() {
            if redirects_left == 0 {
                return Err(SkinError::api(codes::FETCH_REDIRECT, "too many redirects"));
            }
            let loc = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    SkinError::api(codes::FETCH_REDIRECT, "redirect without Location")
                })?;
            let next = upgrade_known_host(
                current.join(loc).map_err(|_| {
                    SkinError::api(codes::FETCH_REDIRECT, "invalid redirect target")
                })?,
            );
            if !matches!(next.scheme(), "http" | "https") {
                return Err(SkinError::api(
                    codes::FETCH_REDIRECT,
                    format!("redirect to {} refused", next.scheme()),
                ));
            }
            if current.scheme() == "https" && next.scheme() == "http" {
                return Err(SkinError::api(
                    codes::FETCH_REDIRECT,
                    "https→http downgrade refused",
                ));
            }
            current = next;
            continue;
        }
        if !status.is_success() {
            return Err(SkinError::api(
                codes::FETCH_FAILED,
                format!("HTTP {}", status.as_u16()),
            ));
        }
        // Refuse transparent content decoding.
        if let Some(enc) = resp
            .headers()
            .get("content-encoding")
            .and_then(|v| v.to_str().ok())
        {
            let enc = enc.trim().to_ascii_lowercase();
            if !enc.is_empty() && enc != "identity" {
                return Err(SkinError::api(
                    codes::FETCH_FAILED,
                    format!("content-encoding {enc} not accepted"),
                ));
            }
        }
        if let Some(len) = resp.content_length() {
            if len as usize > MAX_BYTES {
                return Err(SkinError::api(
                    codes::PAYLOAD_TOO_LARGE,
                    format!("body exceeds {MAX_BYTES} bytes"),
                ));
            }
        }
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        // Bounded read: chunk-accumulate with a hard cap.
        let mut resp = resp;
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(map_reqwest_err)? {
            if body.len() + chunk.len() > MAX_BYTES {
                return Err(SkinError::api(
                    codes::PAYLOAD_TOO_LARGE,
                    format!("body exceeds {MAX_BYTES} bytes"),
                ));
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(Fetched { body, content_type, final_url: current });
    }
    Err(SkinError::api(codes::FETCH_REDIRECT, "too many redirects"))
}

fn map_reqwest_err(e: reqwest::Error) -> SkinError {
    if e.is_timeout() {
        SkinError::api(codes::FETCH_TIMEOUT, "request timed out")
    } else if e.is_redirect() {
        SkinError::api(codes::FETCH_REDIRECT, "redirect error")
    } else {
        SkinError::api(codes::FETCH_FAILED, format!("request failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn futures_block<F: std::future::Future<Output = SkinResult<Fetched>>>(f: F) -> SkinError {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
            .unwrap_err()
    }

    #[test]
    fn rejects_non_http_scheme() {
        let err = futures_block(safe_fetch("ftp://example.com/x.png"));
        assert_eq!(err.code(), "FETCH_FAILED");
    }

    #[test]
    fn rejects_credentials() {
        let err = futures_block(safe_fetch("http://user:pass@example.com/x.png"));
        assert_eq!(err.code(), "FETCH_FAILED");
    }

    #[test]
    fn rejects_non_standard_port() {
        let err = futures_block(safe_fetch("http://example.com:8080/x.png"));
        assert_eq!(err.code(), "FETCH_FAILED");
    }

    #[test]
    fn rejects_loopback_literal() {
        let err = futures_block(safe_fetch("http://127.0.0.1/x.png"));
        assert_eq!(err.code(), "FETCH_FORBIDDEN_ADDRESS");
    }

    #[test]
    fn rejects_ipv6_loopback_literal() {
        let err = futures_block(safe_fetch("http://[::1]/x.png"));
        assert_eq!(err.code(), "FETCH_FORBIDDEN_ADDRESS");
    }

    #[test]
    fn rejects_private_literal() {
        let err = futures_block(safe_fetch("http://192.168.1.10/x.png"));
        assert_eq!(err.code(), "FETCH_FORBIDDEN_ADDRESS");
    }
}
