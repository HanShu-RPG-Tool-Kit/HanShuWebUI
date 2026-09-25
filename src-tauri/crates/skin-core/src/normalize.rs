//! PNG decode + Minecraft skin normalization (port of `service/src/normalize.ts`).
//!
//! Pipeline: bounded input → raw header check (signature, IHDR, dims, bit
//! depth, color type, interlace, APNG chunks) → decode to RGBA → legacy 64x32
//! expansion → vanilla base-layer alpha fix-up → transparent RGB zeroing.

use crate::codec::{limits, RGBA_LENGTH, SKIN_HEIGHT, SKIN_WIDTH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizeError {
    pub code: &'static str,
    pub message: String,
}

impl NormalizeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for NormalizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NormalizeError {}

const PNG_SIG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

struct PngHeader {
    width: u32,
    height: u32,
    bit_depth: u8,
    color_type: u8,
    interlace: u8,
    is_apng: bool,
}

/// Parse the fixed prefix + scan chunk types for acTL (APNG) before IDAT.
fn inspect_png(buf: &[u8]) -> Result<PngHeader, NormalizeError> {
    if buf.len() < 33 || buf[0..8] != PNG_SIG {
        return Err(NormalizeError::new("NOT_PNG", "missing PNG signature"));
    }
    let ihdr_len = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]) as usize;
    if ihdr_len != 13 || &buf[12..16] != b"IHDR" {
        return Err(NormalizeError::new("BAD_PNG", "first chunk is not IHDR"));
    }
    let width = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
    let height = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
    let bit_depth = buf[24];
    let color_type = buf[25];
    let interlace = buf[28];
    // Scan chunk types for acTL to detect APNG without full decode.
    let mut off = 8 + 4 + 4 + ihdr_len + 4;
    let mut is_apng = false;
    while off + 8 <= buf.len() {
        let len = u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
            as usize;
        let typ = &buf[off + 4..off + 8];
        if typ == b"acTL" {
            is_apng = true;
            break;
        }
        if typ == b"IDAT" {
            break; // acTL must precede IDAT; stop early
        }
        // checked advance — refuse absurd chunk lengths instead of panicking
        match off.checked_add(4 + 4 + len + 4) {
            Some(next) if next <= buf.len() => off = next,
            _ => break,
        }
    }
    Ok(PngHeader { width, height, bit_depth, color_type, interlace, is_apng })
}

/// Vanilla base-layer regions that must be opaque after normalization.
/// Coordinates in 64x64 space, (x0, y0, x1, y1) inclusive-exclusive.
const BASE_REGIONS: [(usize, usize, usize, usize); 6] = [
    (0, 8, 32, 16),    // head base
    (16, 20, 40, 32),  // body base
    (40, 20, 56, 32),  // right arm base
    (0, 20, 16, 32),   // right leg base
    (32, 52, 48, 64),  // left arm base
    (16, 52, 32, 64),  // left leg base
];

/// Legacy 64x32 hat layer region (transparency allowed for compat).
const HAT_REGION_32: (usize, usize, usize, usize) = (32, 0, 64, 16);

fn in_region(x: usize, y: usize, r: (usize, usize, usize, usize)) -> bool {
    x >= r.0 && x < r.2 && y >= r.1 && y < r.3
}

/// Expand a legacy 64x32 skin to 64x64 using vanilla mirroring rules:
/// copy top half, mirror right arm → left arm, right leg → left leg.
fn expand_legacy32(src: &[u8]) -> Vec<u8> {
    let w = SKIN_WIDTH as usize;
    let mut out = vec![0u8; RGBA_LENGTH];
    // Top half: copy as-is.
    out[..w * 32 * 4].copy_from_slice(&src[..w * 32 * 4]);
    let copy_mirrored = |out: &mut Vec<u8>, sx0: usize, sy0: usize, dx0: usize, dy0: usize, cw: usize, ch: usize| {
        for y in 0..ch {
            for x in 0..cw {
                let si = ((sy0 + y) * w + (sx0 + x)) * 4;
                let di = ((dy0 + y) * w + (dx0 + (cw - 1 - x))) * 4;
                out[di..di + 4].copy_from_slice(&src[si..si + 4]);
            }
        }
    };
    copy_mirrored(&mut out, 40, 20, 32, 52, 16, 12); // arm
    copy_mirrored(&mut out, 0, 16, 16, 52, 16, 12); // leg
    out
}

/// Apply vanilla alpha rules: base regions opaque; then zero RGB where alpha==0.
fn apply_alpha_rules(rgba: &mut [u8], is_legacy: bool) {
    let w = SKIN_WIDTH as usize;
    for y in 0..SKIN_HEIGHT as usize {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let in_base = BASE_REGIONS.iter().any(|&r| in_region(x, y, r));
            let in_legacy_hat = is_legacy && in_region(x, y, HAT_REGION_32);
            if in_base && !in_legacy_hat && rgba[i + 3] != 0xff {
                rgba[i + 3] = 0xff;
            }
            if rgba[i + 3] == 0 {
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
            }
        }
    }
}

/// Decode + normalize a PNG buffer to 64x64 RGBA.
/// Returns NormalizeError with a stable code on every reject path.
pub fn normalize_png(buf: &[u8]) -> Result<NormalizedPng, NormalizeError> {
    if buf.len() > limits::PNG_BYTES {
        return Err(NormalizeError::new(
            "PAYLOAD_TOO_LARGE",
            format!("PNG {} bytes exceeds {}", buf.len(), limits::PNG_BYTES),
        ));
    }
    let head = inspect_png(buf)?;
    if head.is_apng {
        return Err(NormalizeError::new("APNG_NOT_SUPPORTED", "APNG is not supported"));
    }
    if head.bit_depth != 8 {
        return Err(NormalizeError::new(
            "UNSUPPORTED_PNG",
            format!("bit depth {} not supported (need 8-bit)", head.bit_depth),
        ));
    }
    if !matches!(head.color_type, 0 | 2 | 3 | 4 | 6) {
        return Err(NormalizeError::new(
            "UNSUPPORTED_PNG",
            format!("color type {} not supported", head.color_type),
        ));
    }
    if head.interlace != 0 {
        return Err(NormalizeError::new(
            "UNSUPPORTED_PNG",
            "interlaced PNG not supported",
        ));
    }
    let is64 = head.width == SKIN_WIDTH as u32 && head.height == SKIN_HEIGHT as u32;
    let is32 = head.width == SKIN_WIDTH as u32 && head.height == 32;
    if !is64 && !is32 {
        return Err(NormalizeError::new(
            "BAD_DIMENSIONS",
            format!(
                "dimensions {}x{}; need 64x64 or legacy 64x32",
                head.width, head.height
            ),
        ));
    }

    // Decode with EXPAND (palette + tRNS → direct color). Bit depth was already
    // checked to be 8, so no 16→8 conversion can silently occur.
    let mut decoder = png::Decoder::new(std::io::Cursor::new(buf));
    decoder.set_transformations(png::Transformations::EXPAND);
    // 64x64 RGBA is tiny; cap allocations well below anything adversarial.
    decoder.set_limits(png::Limits { bytes: RGBA_LENGTH * 4 });
    let mut reader = decoder
        .read_info()
        .map_err(|e| NormalizeError::new("BAD_PNG", format!("decode failed: {e}")))?;
    let mut buf_rgba = vec![0u8; reader.output_buffer_size().unwrap_or(RGBA_LENGTH)];
    let info = reader
        .next_frame(&mut buf_rgba)
        .map_err(|e| NormalizeError::new("BAD_PNG", format!("decode failed: {e}")))?;
    let used = info.buffer_size();
    buf_rgba.truncate(used);
    // Expected raw size follows the actual input dimensions (64x64 or 64x32).
    let expected_raw = head.width as usize * head.height as usize * 4;
    if buf_rgba.len() != expected_raw {
        return Err(NormalizeError::new(
            "BAD_PNG",
            format!("decoded to {} bytes, expected {expected_raw}", buf_rgba.len()),
        ));
    }

    // Normalize the color format to RGBA8 ourselves: EXPAND covers palette and
    // tRNS, but grayscale stays single-channel and RGB lacks alpha.
    let src = to_rgba8(&buf_rgba, info.color_type);

    let mut rgba = if is32 {
        expand_legacy32(&src)
    } else {
        src
    };
    apply_alpha_rules(&mut rgba, is32);
    Ok(NormalizedPng { rgba, was_legacy: is32 })
}

/// Convert decoded output to RGBA8 according to the output color type.
fn to_rgba8(raw: &[u8], color_type: png::ColorType) -> Vec<u8> {
    match color_type {
        png::ColorType::Rgba => raw.to_vec(),
        png::ColorType::Rgb => {
            let mut out = vec![0u8; raw.len() / 3 * 4];
            for (i, chunk) in raw.chunks_exact(3).enumerate() {
                out[i * 4..i * 4 + 3].copy_from_slice(chunk);
                out[i * 4 + 3] = 0xff;
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = vec![0u8; raw.len() * 4];
            for (i, &g) in raw.iter().enumerate() {
                out[i * 4] = g;
                out[i * 4 + 1] = g;
                out[i * 4 + 2] = g;
                out[i * 4 + 3] = 0xff;
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = vec![0u8; raw.len() / 2 * 4];
            for (i, chunk) in raw.chunks_exact(2).enumerate() {
                out[i * 4] = chunk[0];
                out[i * 4 + 1] = chunk[0];
                out[i * 4 + 2] = chunk[0];
                out[i * 4 + 3] = chunk[1];
            }
            out
        }
        png::ColorType::Indexed => {
            // With EXPAND this should not appear; pass through for the length
            // check above to reject.
            raw.to_vec()
        }
    }
}

#[derive(Debug)]
pub struct NormalizedPng {
    pub rgba: Vec<u8>,
    pub was_legacy: bool,
}

/// Encode normalized RGBA to a canonical 64x64 PNG (preview + export).
/// No gamma, no color-space conversion, no premultiplied alpha.
pub fn rgba_to_png(rgba: &[u8]) -> Result<Vec<u8>, NormalizeError> {
    if rgba.len() != RGBA_LENGTH {
        return Err(NormalizeError::new(
            "BAD_DIMENSIONS",
            format!("rgba must be {RGBA_LENGTH} bytes"),
        ));
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, SKIN_WIDTH as u32, SKIN_HEIGHT as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| NormalizeError::new("BAD_PNG", format!("encode failed: {e}")))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| NormalizeError::new("BAD_PNG", format!("encode failed: {e}")))?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_rgba() -> Vec<u8> {
        let mut rgba = vec![0u8; RGBA_LENGTH];
        for (i, chunk) in rgba.chunks_exact_mut(4).enumerate() {
            chunk[0] = (i % 251) as u8;
            chunk[1] = (i % 241) as u8;
            chunk[2] = (i % 239) as u8;
            chunk[3] = 0xff;
        }
        rgba
    }

    #[test]
    fn png_round_trip() {
        let rgba = sample_rgba();
        let png = rgba_to_png(&rgba).unwrap();
        let back = normalize_png(&png).unwrap();
        assert!(!back.was_legacy);
        assert_eq!(back.rgba, rgba);
    }

    #[test]
    fn rejects_not_png() {
        let err = normalize_png(b"not a png at all").unwrap_err();
        assert_eq!(err.code, "NOT_PNG");
    }

    #[test]
    fn rejects_oversized() {
        let big = vec![0u8; limits::PNG_BYTES + 1];
        let err = normalize_png(&big).unwrap_err();
        assert_eq!(err.code, "PAYLOAD_TOO_LARGE");
    }

    #[test]
    fn rejects_wrong_dimensions() {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 32, 32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[0u8; 32 * 32 * 4]).unwrap();
        }
        let err = normalize_png(&out).unwrap_err();
        assert_eq!(err.code, "BAD_DIMENSIONS");
    }

    #[test]
    fn transparent_pixels_get_zeroed_rgb() {
        let mut rgba = sample_rgba();
        // Make one pixel transparent with non-zero RGB (outside base regions
        // so alpha rules don't force it opaque — overlay area y=0..7).
        rgba[0] = 0x12;
        rgba[1] = 0x34;
        rgba[2] = 0x56;
        rgba[3] = 0x00;
        let png = rgba_to_png(&rgba).unwrap();
        let back = normalize_png(&png).unwrap();
        assert_eq!(&back.rgba[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn base_regions_forced_opaque() {
        let mut rgba = sample_rgba();
        // head base pixel (x=1, y=9) transparent in input
        let i = (9 * 64 + 1) * 4;
        rgba[i + 3] = 0;
        let png = rgba_to_png(&rgba).unwrap();
        let back = normalize_png(&png).unwrap();
        assert_eq!(back.rgba[i + 3], 0xff);
    }
}
