//! Hanshu skin object codec.
//!
//! Canonical object `C` (identity; `skinId = sha256(C)`):
//!   magic "HSKN" | version | flags | uvLayout | width(u16 BE) | height(u16 BE)
//!   | rgbaLen(u32 BE) | rgba
//! No model in `C`. Flag bit0 = SEMI_TRANSPARENT.
//!
//! Disk `.skin`: same header fields + enc(u8) + payloadLen + payload
//!   enc=0 raw rgba, enc=1 zlib(rgba).
//!
//! Share string: `hanshu-skin:1:<classic|slim>:<base64url-nopad(zlib(C))>`

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use flate2::read::ZlibEncoder;
use flate2::{Compression, Decompress, FlushDecompress, Status};
use sha2::{Digest, Sha256};
use std::io::Read;

pub const MAGIC: u32 = 0x4853_4b4e; // "HSKN"
pub const FORMAT_VERSION: u8 = 1;
pub const UV_LAYOUT_STANDARD: u8 = 0;
pub const FLAG_SEMI_TRANSPARENT: u8 = 1;
pub const ENC_RAW: u8 = 0;
pub const ENC_ZLIB: u8 = 1;
pub const HEADER_LENGTH: usize = 15; // magic..rgbaLen
pub const DISK_HEADER_LENGTH: usize = 16; // + enc before payloadLen reused layout

pub const SKIN_WIDTH: u16 = 64;
pub const SKIN_HEIGHT: u16 = 64;
pub const MAX_TEXTURE_SIZE: u16 = 1024;
/// Convenience: 64×64 RGBA length.
pub const RGBA_LENGTH: usize = (SKIN_WIDTH as usize) * (SKIN_HEIGHT as usize) * 4;

pub const SHARE_PREFIX: &str = "hanshu-skin:";
pub const SHARE_WIRE_VERSION: &str = "1";

pub mod limits {
    pub const SKIN_CODE_CHARS: usize = 6 * 1024 * 1024;
    pub const COMPRESSED_BYTES: usize = 5 * 1024 * 1024;
    pub const PNG_BYTES: usize = 2 * 1024 * 1024;
    pub const PORTABLE_JSON_BYTES: usize = 64 * 1024;
    pub const MAX_RGBA_BYTES: usize = 1024 * 1024 * 4;
    pub const MAX_DISK_BYTES: usize = 5 * 1024 * 1024;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError {
    pub code: &'static str,
    pub message: String,
}

impl FormatError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
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
    pub fn as_str(self) -> &'static str {
        match self {
            SkinModel::Classic => "classic",
            SkinModel::Slim => "slim",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "classic" => Some(SkinModel::Classic),
            "slim" => Some(SkinModel::Slim),
            _ => None,
        }
    }
}

/// Decoded object content (no model).
#[derive(Debug, Clone)]
pub struct DecodedSkin {
    pub rgba: Vec<u8>,
    pub width: u16,
    pub height: u16,
    pub flags: u8,
}

impl DecodedSkin {
    pub fn semi_transparent(&self) -> bool {
        self.flags & FLAG_SEMI_TRANSPARENT != 0
    }
}

pub fn is_supported_texture_size(width: u16, height: u16) -> bool {
    if width != height {
        return false;
    }
    // Any integer side in range; no longer require multiple of 64.
    (64..=MAX_TEXTURE_SIZE).contains(&width)
}

pub fn rgba_byte_len(width: u16, height: u16) -> usize {
    width as usize * height as usize * 4
}

/// Build canonical object `C`.
pub fn build_c(flags: u8, width: u16, height: u16, rgba: &[u8]) -> Result<Vec<u8>, FormatError> {
    if !is_supported_texture_size(width, height) {
        return Err(FormatError::new(
            "BAD_DIMENSIONS",
            format!("dimensions {width}x{height} not supported"),
        ));
    }
    let expected = rgba_byte_len(width, height);
    if rgba.len() != expected {
        return Err(FormatError::new(
            "BAD_RGBA_LENGTH",
            format!("rgba must be {expected} bytes, got {}", rgba.len()),
        ));
    }
    if expected > limits::MAX_RGBA_BYTES {
        return Err(FormatError::new(
            "PAYLOAD_TOO_LARGE",
            format!("rgba {expected} exceeds {}", limits::MAX_RGBA_BYTES),
        ));
    }
    assert_normalization_invariants(rgba)?;
    let mut c = Vec::with_capacity(HEADER_LENGTH + expected);
    c.extend_from_slice(&MAGIC.to_be_bytes());
    c.push(FORMAT_VERSION);
    c.push(flags);
    c.push(UV_LAYOUT_STANDARD);
    c.extend_from_slice(&width.to_be_bytes());
    c.extend_from_slice(&height.to_be_bytes());
    c.extend_from_slice(&(expected as u32).to_be_bytes());
    c.extend_from_slice(rgba);
    Ok(c)
}

pub fn skin_id_of(c: &[u8]) -> String {
    hex_lower(&Sha256::digest(c))
}

pub fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

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

pub fn parse_c(c: &[u8]) -> Result<DecodedSkin, FormatError> {
    if c.len() < HEADER_LENGTH {
        return Err(FormatError::new(
            "BAD_LENGTH",
            format!("C too short: {} bytes", c.len()),
        ));
    }
    if u32::from_be_bytes([c[0], c[1], c[2], c[3]]) != MAGIC {
        return Err(FormatError::new("BAD_MAGIC", "missing HSKN magic"));
    }
    if c[4] != FORMAT_VERSION {
        return Err(FormatError::new(
            "UNSUPPORTED_VERSION",
            format!("format version {} not supported", c[4]),
        ));
    }
    let flags = c[5];
    if c[6] != UV_LAYOUT_STANDARD {
        return Err(FormatError::new(
            "UNSUPPORTED_UV_LAYOUT",
            format!("uv layout {} not supported", c[6]),
        ));
    }
    let width = u16::from_be_bytes([c[7], c[8]]);
    let height = u16::from_be_bytes([c[9], c[10]]);
    if !is_supported_texture_size(width, height) {
        return Err(FormatError::new(
            "BAD_DIMENSIONS",
            format!("dimensions {width}x{height} not supported"),
        ));
    }
    let rgba_len = u32::from_be_bytes([c[11], c[12], c[13], c[14]]) as usize;
    let expected = rgba_byte_len(width, height);
    if rgba_len != expected {
        return Err(FormatError::new(
            "BAD_RGBA_LENGTH",
            format!("rgbaLength {rgba_len} != expected {expected}"),
        ));
    }
    if c.len() != HEADER_LENGTH + rgba_len {
        return Err(FormatError::new(
            "BAD_LENGTH",
            format!(
                "C is {} bytes, need {}",
                c.len(),
                HEADER_LENGTH + rgba_len
            ),
        ));
    }
    let rgba = c[HEADER_LENGTH..].to_vec();
    assert_normalization_invariants(&rgba)?;
    Ok(DecodedSkin {
        rgba,
        width,
        height,
        flags,
    })
}

fn base64_url_decode(s: &str) -> Result<Vec<u8>, FormatError> {
    if !s
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(FormatError::new(
            "BAD_BASE64",
            "invalid base64url characters",
        ));
    }
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| FormatError::new("BAD_BASE64", format!("invalid base64url: {e}")))
}

fn zlib_deflate(data: &[u8]) -> Result<Vec<u8>, FormatError> {
    let mut enc = ZlibEncoder::new(data, Compression::best());
    let mut out = Vec::new();
    enc.read_to_end(&mut out)
        .map_err(|e| FormatError::new("INFLATE_FAILED", format!("zlib deflate failed: {e}")))?;
    Ok(out)
}

/// Bounded inflate into an exact expected length (no trailing input).
fn bounded_inflate_exact(compressed: &[u8], expected: usize) -> Result<Vec<u8>, FormatError> {
    if expected > limits::MAX_RGBA_BYTES + HEADER_LENGTH {
        return Err(FormatError::new(
            "PAYLOAD_TOO_LARGE",
            format!("expected inflate {expected} too large"),
        ));
    }
    let mut out = vec![0u8; expected + 1];
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
                if out_pos > expected {
                    return Err(FormatError::new(
                        "PAYLOAD_TOO_LARGE",
                        format!("decompressed output exceeds {expected} bytes"),
                    ));
                }
                if in_pos >= compressed.len() {
                    return Err(FormatError::new(
                        "INFLATE_FAILED",
                        "zlib stream truncated before end",
                    ));
                }
            }
        }
    }
    if out_pos != expected {
        return Err(FormatError::new(
            "BAD_LENGTH",
            format!("decompressed is {out_pos} bytes, need exactly {expected}"),
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
    out.truncate(expected);
    Ok(out)
}

/// Encode disk `.skin` bytes (zlib rgba payload).
pub fn encode_disk_file(decoded: &DecodedSkin) -> Result<Vec<u8>, FormatError> {
    let c = build_c(decoded.flags, decoded.width, decoded.height, &decoded.rgba)?;
    let rgba = &c[HEADER_LENGTH..];
    let payload = zlib_deflate(rgba)?;
    if payload.len() > limits::COMPRESSED_BYTES {
        return Err(FormatError::new(
            "PAYLOAD_TOO_LARGE",
            format!(
                "compressed payload {} exceeds {}",
                payload.len(),
                limits::COMPRESSED_BYTES
            ),
        ));
    }
    let mut out = Vec::with_capacity(DISK_HEADER_LENGTH + payload.len());
    out.extend_from_slice(&MAGIC.to_be_bytes());
    out.push(FORMAT_VERSION);
    out.push(decoded.flags);
    out.push(UV_LAYOUT_STANDARD);
    out.extend_from_slice(&decoded.width.to_be_bytes());
    out.extend_from_slice(&decoded.height.to_be_bytes());
    out.push(ENC_ZLIB);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Decode disk `.skin` bytes → object + skinId.
pub fn decode_disk_file(buf: &[u8]) -> Result<(DecodedSkin, String), FormatError> {
    if buf.len() > limits::MAX_DISK_BYTES {
        return Err(FormatError::new(
            "PAYLOAD_TOO_LARGE",
            format!("disk file {} exceeds {}", buf.len(), limits::MAX_DISK_BYTES),
        ));
    }
    if buf.len() < DISK_HEADER_LENGTH {
        return Err(FormatError::new("BAD_LENGTH", "disk file too short"));
    }
    if u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) != MAGIC {
        return Err(FormatError::new("BAD_MAGIC", "missing HSKN magic"));
    }
    if buf[4] != FORMAT_VERSION {
        return Err(FormatError::new(
            "UNSUPPORTED_VERSION",
            format!("format version {} not supported", buf[4]),
        ));
    }
    let flags = buf[5];
    if buf[6] != UV_LAYOUT_STANDARD {
        return Err(FormatError::new(
            "UNSUPPORTED_UV_LAYOUT",
            format!("uv layout {} not supported", buf[6]),
        ));
    }
    let width = u16::from_be_bytes([buf[7], buf[8]]);
    let height = u16::from_be_bytes([buf[9], buf[10]]);
    if !is_supported_texture_size(width, height) {
        return Err(FormatError::new(
            "BAD_DIMENSIONS",
            format!("dimensions {width}x{height} not supported"),
        ));
    }
    let enc = buf[11];
    let payload_len = u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]) as usize;
    if buf.len() != DISK_HEADER_LENGTH + payload_len {
        return Err(FormatError::new(
            "BAD_LENGTH",
            format!(
                "disk file is {} bytes, need {}",
                buf.len(),
                DISK_HEADER_LENGTH + payload_len
            ),
        ));
    }
    let payload = &buf[DISK_HEADER_LENGTH..];
    let expected_rgba = rgba_byte_len(width, height);
    let rgba = match enc {
        ENC_RAW => {
            if payload.len() != expected_rgba {
                return Err(FormatError::new(
                    "BAD_RGBA_LENGTH",
                    format!("raw payload {} != {expected_rgba}", payload.len()),
                ));
            }
            payload.to_vec()
        }
        ENC_ZLIB => {
            if payload.len() > limits::COMPRESSED_BYTES {
                return Err(FormatError::new(
                    "PAYLOAD_TOO_LARGE",
                    format!(
                        "compressed payload {} exceeds {}",
                        payload.len(),
                        limits::COMPRESSED_BYTES
                    ),
                ));
            }
            bounded_inflate_exact(payload, expected_rgba)?
        }
        other => {
            return Err(FormatError::new(
                "UNSUPPORTED_ENCODING",
                format!("payload encoding {other} not supported"),
            ));
        }
    };
    let c = build_c(flags, width, height, &rgba)?;
    let decoded = parse_c(&c)?;
    let skin_id = skin_id_of(&c);
    Ok((decoded, skin_id))
}

/// Share string: `hanshu-skin:1:<model>:<b64(zlib(C))>`.
pub fn encode_share_code(model: SkinModel, decoded: &DecodedSkin) -> Result<String, FormatError> {
    let c = build_c(decoded.flags, decoded.width, decoded.height, &decoded.rgba)?;
    let compressed = zlib_deflate(&c)?;
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
        "{SHARE_PREFIX}{SHARE_WIRE_VERSION}:{}:{}",
        model.as_str(),
        URL_SAFE_NO_PAD.encode(&compressed)
    ))
}

pub fn decode_share_code(code: &str) -> Result<(DecodedSkin, SkinModel, String), FormatError> {
    let code = code.trim();
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
    let rest = code.strip_prefix(SHARE_PREFIX).ok_or_else(|| {
        FormatError::new(
            "BAD_PREFIX",
            format!("expected prefix \"{SHARE_PREFIX}\""),
        )
    })?;
    let mut parts = rest.splitn(3, ':');
    let ver = parts.next().unwrap_or("");
    let model_s = parts.next().unwrap_or("");
    let b64 = parts.next().unwrap_or("");
    if ver != SHARE_WIRE_VERSION {
        return Err(FormatError::new(
            "UNSUPPORTED_VERSION",
            format!("share wire version {ver} not supported"),
        ));
    }
    let model = SkinModel::parse(model_s).ok_or_else(|| {
        FormatError::new(
            "UNSUPPORTED_MODEL",
            format!("model \"{model_s}\" unknown"),
        )
    })?;
    if b64.is_empty() {
        return Err(FormatError::new("BAD_BASE64", "missing share payload"));
    }
    let compressed = base64_url_decode(b64)?;
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
    // Peek header from inflated stream: inflate into max then parse, or
    // two-phase — inflate with max C size bound.
    let max_c = HEADER_LENGTH + limits::MAX_RGBA_BYTES;
    let c = bounded_inflate_max(&compressed, max_c)?;
    let decoded = parse_c(&c)?;
    let skin_id = skin_id_of(&c);
    Ok((decoded, model, skin_id))
}

/// Inflate with unknown exact size: accept any length ≤ max, stream must end cleanly.
fn bounded_inflate_max(compressed: &[u8], max_out: usize) -> Result<Vec<u8>, FormatError> {
    let mut out = vec![0u8; max_out + 1];
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
                if out_pos > max_out {
                    return Err(FormatError::new(
                        "PAYLOAD_TOO_LARGE",
                        format!("decompressed output exceeds {max_out} bytes"),
                    ));
                }
                if in_pos >= compressed.len() {
                    return Err(FormatError::new(
                        "INFLATE_FAILED",
                        "zlib stream truncated before end",
                    ));
                }
            }
        }
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
    out.truncate(out_pos);
    Ok(out)
}

pub fn zlib_compress(data: &[u8]) -> Vec<u8> {
    zlib_deflate(data).expect("compress")
}

pub fn base64_standard(data: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    STANDARD.encode(data)
}

pub fn is_valid_skin_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_rgba(w: u16, h: u16) -> Vec<u8> {
        let mut rgba = vec![0u8; rgba_byte_len(w, h)];
        for (i, chunk) in rgba.chunks_exact_mut(4).enumerate() {
            if i % 7 == 0 {
                continue;
            }
            chunk[0] = (i % 251) as u8;
            chunk[1] = (i % 241) as u8;
            chunk[2] = (i % 239) as u8;
            chunk[3] = 0xff;
        }
        rgba
    }

    #[test]
    fn build_c_layout() {
        let rgba = sample_rgba(64, 64);
        let c = build_c(0, 64, 64, &rgba).unwrap();
        assert_eq!(&c[0..4], b"HSKN");
        assert_eq!(c[4], 1);
        assert_eq!(c[5], 0);
        assert_eq!(c[6], 0);
        assert_eq!(u16::from_be_bytes([c[7], c[8]]), 64);
        assert_eq!(c.len(), HEADER_LENGTH + 16384);
    }

    #[test]
    fn model_not_in_object_same_skin_id() {
        let rgba = sample_rgba(64, 64);
        let d = DecodedSkin {
            rgba,
            width: 64,
            height: 64,
            flags: 0,
        };
        let a = encode_share_code(SkinModel::Classic, &d).unwrap();
        let b = encode_share_code(SkinModel::Slim, &d).unwrap();
        let (_, _, id_a) = decode_share_code(&a).unwrap();
        let (_, _, id_b) = decode_share_code(&b).unwrap();
        assert_eq!(id_a, id_b);
        assert!(a.contains(":classic:"));
        assert!(b.contains(":slim:"));
    }

    #[test]
    fn disk_round_trip() {
        let d = DecodedSkin {
            rgba: sample_rgba(128, 128),
            width: 128,
            height: 128,
            flags: FLAG_SEMI_TRANSPARENT,
        };
        let disk = encode_disk_file(&d).unwrap();
        let (back, id) = decode_disk_file(&disk).unwrap();
        assert_eq!(back.width, 128);
        assert_eq!(back.flags, FLAG_SEMI_TRANSPARENT);
        assert_eq!(back.rgba, d.rgba);
        assert_eq!(id.len(), 64);
    }

    #[test]
    fn share_round_trip() {
        let d = DecodedSkin {
            rgba: sample_rgba(64, 64),
            width: 64,
            height: 64,
            flags: 0,
        };
        let code = encode_share_code(SkinModel::Slim, &d).unwrap();
        assert!(code.starts_with("hanshu-skin:1:slim:"));
        let (back, model, _) = decode_share_code(&code).unwrap();
        assert_eq!(model, SkinModel::Slim);
        assert_eq!(back.rgba, d.rgba);
    }

    #[test]
    fn rejects_bad_prefix() {
        let err = decode_share_code("hskin1:AAAA").unwrap_err();
        assert_eq!(err.code, "BAD_PREFIX");
    }

    #[test]
    fn rejects_nonzero_rgb_on_transparent() {
        let mut rgba = sample_rgba(64, 64);
        rgba[0] = 0xff;
        let err = build_c(0, 64, 64, &rgba).unwrap_err();
        assert_eq!(err.code, "NORMALIZATION_INVARIANT");
    }
}
