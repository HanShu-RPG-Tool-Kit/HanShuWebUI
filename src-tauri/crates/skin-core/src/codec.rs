//! hskin1 codec — byte-identical port of the Node `shared/src/codec.ts`.
//!
//! Wire form: `"hskin1:" + base64url-no-pad( zlib( P ) )`
//! P layout (16399 bytes): magic "HSK1" | normVersion | uvLayout | model |
//! width(u16 BE) | height(u16 BE) | rgbaLength(u32 BE) | rgba(16384).
//! skinId = lowercase hex SHA-256(P).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use flate2::read::ZlibEncoder;
use flate2::{Compression, Decompress, FlushDecompress, Status};
use sha2::{Digest, Sha256};
use std::io::Read;

pub const FORMAT_PREFIX: &str = "hskin1:";
pub const MAGIC: u32 = 0x4853_4b31; // "HSK1"
pub const NORMALIZATION_VERSION: u8 = 1;
pub const UV_LAYOUT_STANDARD: u8 = 0;
pub const MODEL_CLASSIC: u8 = 0;
pub const MODEL_SLIM: u8 = 1;
pub const SKIN_WIDTH: u16 = 64;
pub const SKIN_HEIGHT: u16 = 64;
pub const RGBA_LENGTH: usize = SKIN_WIDTH as usize * SKIN_HEIGHT as usize * 4; // 16384
pub const HEADER_LENGTH: usize = 15;
pub const P_LENGTH: usize = HEADER_LENGTH + RGBA_LENGTH; // 16399

/// Input/size limits — enforced here, not only in the UI.
pub mod limits {
    pub const SKIN_CODE_CHARS: usize = 24 * 1024;
    pub const COMPRESSED_BYTES: usize = 18 * 1024;
    pub const PNG_BYTES: usize = 512 * 1024;
    pub const PORTABLE_JSON_BYTES: usize = 64 * 1024;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError {
    pub code: &'static str,
    pub message: String,
}

impl FormatError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for FormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FormatError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkinModel {
    Classic,
    Slim,
}

impl SkinModel {
    pub fn to_byte(self) -> u8 {
        match self {
            SkinModel::Classic => MODEL_CLASSIC,
            SkinModel::Slim => MODEL_SLIM,
        }
    }

    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            MODEL_CLASSIC => Some(SkinModel::Classic),
            MODEL_SLIM => Some(SkinModel::Slim),
            _ => None,
        }
    }
}

/// Decoded, validated skin content. `rgba` is exactly 16384 bytes.
#[derive(Debug, Clone)]
pub struct DecodedSkin {
    pub model: SkinModel,
    pub rgba: Vec<u8>,
}

/// Build the 16399-byte P buffer from normalized pixels + model.
pub fn build_p(model: SkinModel, rgba: &[u8]) -> Result<Vec<u8>, FormatError> {
    if rgba.len() != RGBA_LENGTH {
        return Err(FormatError::new(
            "BAD_RGBA_LENGTH",
            format!("rgba must be {RGBA_LENGTH} bytes, got {}", rgba.len()),
        ));
    }
    let mut p = Vec::with_capacity(P_LENGTH);
    p.extend_from_slice(&MAGIC.to_be_bytes());
    p.push(NORMALIZATION_VERSION);
    p.push(UV_LAYOUT_STANDARD);
    p.push(model.to_byte());
    p.extend_from_slice(&SKIN_WIDTH.to_be_bytes());
    p.extend_from_slice(&SKIN_HEIGHT.to_be_bytes());
    p.extend_from_slice(&(RGBA_LENGTH as u32).to_be_bytes());
    p.extend_from_slice(rgba);
    debug_assert_eq!(p.len(), P_LENGTH);
    Ok(p)
}

/// skinId = lowercase hex SHA-256(P).
pub fn skin_id_of(p: &[u8]) -> String {
    let digest = Sha256::digest(p);
    hex_lower(&digest)
}

pub fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Check normalization invariants: fully transparent pixels must have zeroed RGB.
pub fn assert_normalization_invariants(rgba: &[u8]) -> Result<(), FormatError> {
    for (i, chunk) in rgba.chunks_exact(4).enumerate() {
        if chunk[3] == 0 && (chunk[0] != 0 || chunk[1] != 0 || chunk[2] != 0) {
            return Err(FormatError::new(
                "NORMALIZATION_INVARIANT",
                format!("transparent pixel at byte {} carries non-zero RGB", i * 4),
            ));
        }
    }
    Ok(())
}

/// Parse and fully validate the P buffer.
pub fn parse_p(p: &[u8]) -> Result<DecodedSkin, FormatError> {
    if p.len() != P_LENGTH {
        return Err(FormatError::new(
            "BAD_LENGTH",
            format!("P must be exactly {P_LENGTH} bytes, got {}", p.len()),
        ));
    }
    if u32::from_be_bytes([p[0], p[1], p[2], p[3]]) != MAGIC {
        return Err(FormatError::new("BAD_MAGIC", "missing HSK1 magic"));
    }
    if p[4] != NORMALIZATION_VERSION {
        return Err(FormatError::new(
            "UNSUPPORTED_VERSION",
            format!("normalization version {} not supported", p[4]),
        ));
    }
    if p[5] != UV_LAYOUT_STANDARD {
        return Err(FormatError::new(
            "UNSUPPORTED_UV_LAYOUT",
            format!("uv layout {} not supported", p[5]),
        ));
    }
    let model = SkinModel::from_byte(p[6]).ok_or_else(|| {
        FormatError::new("UNSUPPORTED_MODEL", format!("model byte {} unknown", p[6]))
    })?;
    if u16::from_be_bytes([p[7], p[8]]) != SKIN_WIDTH
        || u16::from_be_bytes([p[9], p[10]]) != SKIN_HEIGHT
    {
        return Err(FormatError::new("BAD_DIMENSIONS", "dimensions must be 64x64"));
    }
    if u32::from_be_bytes([p[11], p[12], p[13], p[14]]) as usize != RGBA_LENGTH {
        return Err(FormatError::new("BAD_RGBA_LENGTH", "rgbaLength must be 16384"));
    }
    let rgba = p[HEADER_LENGTH..].to_vec();
    assert_normalization_invariants(&rgba)?;
    Ok(DecodedSkin { model, rgba })
}

fn base64_url_decode(s: &str) -> Result<Vec<u8>, FormatError> {
    if !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(FormatError::new("BAD_BASE64", "invalid base64url characters"));
    }
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| FormatError::new("BAD_BASE64", format!("invalid base64url: {e}")))
}

/// Bounded zlib inflate: output must be exactly P_LENGTH and the stream must
/// reach a clean end. Refuses truncated, corrupt, oversized and trailing-data
/// streams (stricter than the old Node decoder, which ignored trailing bytes).
fn bounded_inflate(compressed: &[u8]) -> Result<Vec<u8>, FormatError> {
    let mut out = vec![0u8; P_LENGTH + 1]; // +1 byte detects over-limit output
    let mut d = Decompress::new(true);
    let mut in_pos = 0usize;
    let mut out_pos = 0usize;
    loop {
        let before_in = d.total_in() as usize;
        let before_out = d.total_out() as usize;
        let status = d
            .decompress(
                &compressed[in_pos..],
                &mut out[out_pos..],
                FlushDecompress::None,
            )
            .map_err(|e| FormatError::new("INFLATE_FAILED", format!("zlib inflate failed: {e}")))?;
        in_pos += d.total_in() as usize - before_in;
        out_pos += d.total_out() as usize - before_out;
        match status {
            Status::StreamEnd => break,
            Status::Ok | Status::BufError => {
                if out_pos > P_LENGTH {
                    return Err(FormatError::new(
                        "PAYLOAD_TOO_LARGE",
                        format!("decompressed output exceeds {P_LENGTH} bytes"),
                    ));
                }
                if in_pos >= compressed.len() {
                    // Input exhausted but stream not ended: truncated.
                    return Err(FormatError::new(
                        "INFLATE_FAILED",
                        "zlib stream truncated before end",
                    ));
                }
            }
        }
    }
    if out_pos != P_LENGTH {
        return Err(FormatError::new(
            "BAD_LENGTH",
            format!("decompressed P is {out_pos} bytes, need exactly {P_LENGTH}"),
        ));
    }
    if in_pos != compressed.len() {
        return Err(FormatError::new(
            "INFLATE_FAILED",
            format!(
                "{} trailing bytes after zlib stream",
                compressed.len() - in_pos
            ),
        ));
    }
    out.truncate(P_LENGTH);
    Ok(out)
}

/// Encode normalized skin to the "hskin1:..." wire string.
pub fn encode_skin_code(model: SkinModel, rgba: &[u8]) -> Result<String, FormatError> {
    let p = build_p(model, rgba)?;
    let mut enc = ZlibEncoder::new(&p[..], Compression::best());
    let mut compressed = Vec::new();
    enc.read_to_end(&mut compressed)
        .map_err(|e| FormatError::new("INFLATE_FAILED", format!("zlib deflate failed: {e}")))?;
    if compressed.len() > limits::COMPRESSED_BYTES {
        return Err(FormatError::new(
            "PAYLOAD_TOO_LARGE",
            format!(
                "compressed payload {} exceeds {}",
                compressed.len(),
                limits::COMPRESSED_BYTES
            ),
        ));
    }
    Ok(format!(
        "{FORMAT_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(&compressed)
    ))
}

/// Standard (non-URL-safe) Base64 encode — used for Mojang textures and
/// PNG export payloads. Re-exported for the Tauri adapter.
pub fn base64_standard(data: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    base64::Engine::encode(&STANDARD, data)
}

/// Compress helper reused by tests to build adversarial streams.
pub fn zlib_compress(data: &[u8]) -> Vec<u8> {
    let mut enc = ZlibEncoder::new(data, Compression::best());
    let mut out = Vec::new();
    enc.read_to_end(&mut out).expect("compress");
    out
}

/// Decode and validate a "hskin1:..." wire string.
pub fn decode_skin_code(code: &str) -> Result<(DecodedSkin, String), FormatError> {
    if code.len() > limits::SKIN_CODE_CHARS {
        return Err(FormatError::new(
            "PAYLOAD_TOO_LARGE",
            format!(
                "skin code {} chars exceeds {}",
                code.chars().count(),
                limits::SKIN_CODE_CHARS
            ),
        ));
    }
    let payload = code.strip_prefix(FORMAT_PREFIX).ok_or_else(|| {
        FormatError::new("BAD_PREFIX", format!("expected prefix \"{FORMAT_PREFIX}\""))
    })?;
    let compressed = base64_url_decode(payload)?;
    if compressed.len() > limits::COMPRESSED_BYTES {
        return Err(FormatError::new(
            "PAYLOAD_TOO_LARGE",
            format!(
                "compressed payload {} exceeds {}",
                compressed.len(),
                limits::COMPRESSED_BYTES
            ),
        ));
    }
    let p = bounded_inflate(&compressed)?;
    let decoded = parse_p(&p)?;
    let skin_id = skin_id_of(&p);
    Ok((decoded, skin_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_rgba() -> Vec<u8> {
        // Deterministic pattern with some transparent pixels (RGB zeroed).
        let mut rgba = vec![0u8; RGBA_LENGTH];
        for (i, chunk) in rgba.chunks_exact_mut(4).enumerate() {
            if i % 7 == 0 {
                continue; // stays fully zero → transparent with zeroed RGB
            }
            chunk[0] = (i % 251) as u8;
            chunk[1] = (i % 241) as u8;
            chunk[2] = (i % 239) as u8;
            chunk[3] = 0xff;
        }
        rgba
    }

    #[test]
    fn build_p_layout() {
        let p = build_p(SkinModel::Slim, &sample_rgba()).unwrap();
        assert_eq!(p.len(), P_LENGTH);
        assert_eq!(&p[0..4], b"HSK1");
        assert_eq!(p[4], 1);
        assert_eq!(p[5], 0);
        assert_eq!(p[6], MODEL_SLIM);
        assert_eq!(u16::from_be_bytes([p[7], p[8]]), 64);
        assert_eq!(u16::from_be_bytes([p[9], p[10]]), 64);
        assert_eq!(u32::from_be_bytes([p[11], p[12], p[13], p[14]]), 16384);
    }

    #[test]
    fn round_trip_classic_and_slim() {
        for model in [SkinModel::Classic, SkinModel::Slim] {
            let rgba = sample_rgba();
            let code = encode_skin_code(model, &rgba).unwrap();
            let (decoded, skin_id) = decode_skin_code(&code).unwrap();
            assert_eq!(decoded.model, model);
            assert_eq!(decoded.rgba, rgba);
            assert_eq!(skin_id.len(), 64);
            assert!(skin_id.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        }
    }

    #[test]
    fn model_changes_skin_id() {
        let rgba = sample_rgba();
        let a = skin_id_of(&build_p(SkinModel::Classic, &rgba).unwrap());
        let b = skin_id_of(&build_p(SkinModel::Slim, &rgba).unwrap());
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_bad_prefix() {
        let err = decode_skin_code("hskin2:AAAA").unwrap_err();
        assert_eq!(err.code, "BAD_PREFIX");
    }

    #[test]
    fn rejects_bad_base64() {
        let err = decode_skin_code("hskin1:!!!not-base64!!!").unwrap_err();
        assert_eq!(err.code, "BAD_BASE64");
    }

    #[test]
    fn rejects_oversized_code() {
        let long = "hskin1:".to_string() + &"A".repeat(limits::SKIN_CODE_CHARS);
        let err = decode_skin_code(&long).unwrap_err();
        assert_eq!(err.code, "PAYLOAD_TOO_LARGE");
    }

    #[test]
    fn rejects_truncated_stream() {
        let rgba = sample_rgba();
        let code = encode_skin_code(SkinModel::Classic, &rgba).unwrap();
        let payload = &code[FORMAT_PREFIX.len()..];
        let mut compressed = URL_SAFE_NO_PAD.decode(payload).unwrap();
        compressed.truncate(compressed.len() / 2);
        let cut = format!("{FORMAT_PREFIX}{}", URL_SAFE_NO_PAD.encode(&compressed));
        let err = decode_skin_code(&cut).unwrap_err();
        assert_eq!(err.code, "INFLATE_FAILED");
    }

    #[test]
    fn rejects_trailing_data_after_stream() {
        let rgba = sample_rgba();
        let code = encode_skin_code(SkinModel::Classic, &rgba).unwrap();
        let payload = &code[FORMAT_PREFIX.len()..];
        let mut compressed = URL_SAFE_NO_PAD.decode(payload).unwrap();
        compressed.push(0x00); // extra byte after the zlib stream
        let padded = format!("{FORMAT_PREFIX}{}", URL_SAFE_NO_PAD.encode(&compressed));
        let err = decode_skin_code(&padded).unwrap_err();
        assert_eq!(err.code, "INFLATE_FAILED");
    }

    #[test]
    fn rejects_decompression_bomb() {
        // A zlib stream that would expand far beyond P_LENGTH.
        let bomb = vec![0u8; 200_000];
        let compressed = zlib_compress(&bomb);
        let code = format!("{FORMAT_PREFIX}{}", URL_SAFE_NO_PAD.encode(&compressed));
        let err = decode_skin_code(&code).unwrap_err();
        assert!(matches!(err.code, "PAYLOAD_TOO_LARGE" | "BAD_LENGTH"));
    }

    #[test]
    fn parse_p_rejects_bad_magic_and_version() {
        let mut p = build_p(SkinModel::Classic, &sample_rgba()).unwrap();
        p[0] = b'X';
        assert_eq!(parse_p(&p).unwrap_err().code, "BAD_MAGIC");
        let mut p = build_p(SkinModel::Classic, &sample_rgba()).unwrap();
        p[4] = 2;
        assert_eq!(parse_p(&p).unwrap_err().code, "UNSUPPORTED_VERSION");
        let mut p = build_p(SkinModel::Classic, &sample_rgba()).unwrap();
        p[6] = 9;
        assert_eq!(parse_p(&p).unwrap_err().code, "UNSUPPORTED_MODEL");
    }

    #[test]
    fn parse_p_rejects_nonzero_rgb_on_transparent() {
        let mut rgba = sample_rgba();
        rgba[0] = 0xff; // alpha stays 0 → invariant violation
        let p = build_p(SkinModel::Classic, &rgba).unwrap();
        assert_eq!(parse_p(&p).unwrap_err().code, "NORMALIZATION_INVARIANT");
    }

    #[test]
    fn parse_p_rejects_wrong_length() {
        let p = build_p(SkinModel::Classic, &sample_rgba()).unwrap();
        let err = parse_p(&p[..P_LENGTH - 1]).unwrap_err();
        assert_eq!(err.code, "BAD_LENGTH");
    }
}
