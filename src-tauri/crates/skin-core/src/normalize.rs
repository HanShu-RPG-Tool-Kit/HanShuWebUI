//! PNG decode + Minecraft skin normalization.
//!
//! Pipeline: bounded input → header check → decode RGBA → optional half-height
//! expand (64×32 / 128×64 / … → square) → alpha rules → full-res store
//! (square HD kept at original size; no downscale).

use crate::codec::{
    limits, SkinModel, FLAG_SEMI_TRANSPARENT, MAX_TEXTURE_SIZE as CODEC_MAX, RGBA_LENGTH,
    SKIN_HEIGHT, SKIN_WIDTH,
};

pub const MAX_TEXTURE_SIZE: u32 = CODEC_MAX as u32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizeError {
    pub code: &'static str,
    pub message: String,
}

impl NormalizeError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
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
    let mut off = 8 + 4 + 4 + ihdr_len + 4;
    let mut is_apng = false;
    while off + 8 <= buf.len() {
        let len = u32::from_be_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]) as usize;
        let typ = &buf[off + 4..off + 8];
        if typ == b"acTL" {
            is_apng = true;
            break;
        }
        if typ == b"IDAT" {
            break;
        }
        match off.checked_add(4 + 4 + len + 4) {
            Some(next) if next <= buf.len() => off = next,
            _ => break,
        }
    }
    Ok(PngHeader {
        width,
        height,
        bit_depth,
        color_type,
        interlace,
        is_apng,
    })
}

const BASE_REGIONS_64: [(usize, usize, usize, usize); 6] = [
    (0, 8, 32, 16),
    (16, 20, 40, 32),
    (40, 20, 56, 32),
    (0, 20, 16, 32),
    (32, 52, 48, 64),
    (16, 52, 32, 64),
];

/// After Notch clear, restore these strips (PrismLauncher opaqueParts).
const NOTCH_RESTORE_64: [(usize, usize, usize, usize); 3] = [
    (0, 0, 32, 16),
    (0, 16, 64, 32),
    (16, 48, 48, 64),
];

fn in_region(x: usize, y: usize, r: (usize, usize, usize, usize)) -> bool {
    x >= r.0 && x < r.2 && y >= r.1 && y < r.3
}

fn map64(coord: usize, width: usize) -> usize {
    coord * width / 64
}

/// Expand half-height skin (width × width/2) to square (width × width).
/// Matches skinview-utils `convertSkinTo1_8`: per-face horizontal flip into
/// left-limb UV slots (not a single 16×12 block flop).
fn expand_half_height(src: &[u8], width: usize) -> Vec<u8> {
    let w = width;
    let half_h = w / 2;
    let mut out = vec![0u8; w * w * 4];
    out[..w * half_h * 4].copy_from_slice(&src[..w * half_h * 4]);
    let copy_face =
        |out: &mut [u8], sx0: usize, sy0: usize, fw: usize, fh: usize, dx0: usize, dy0: usize| {
            let sx = map64(sx0, w);
            let sy = map64(sy0, w);
            let dx = map64(dx0, w);
            let dy = map64(dy0, w);
            let fw_s = map64(fw, w);
            let fh_s = map64(fh, w);
            for y in 0..fh_s {
                for x in 0..fw_s {
                    let si = ((sy + y) * w + (sx + x)) * 4;
                    let di = ((dy + y) * w + (dx + (fw_s - 1 - x))) * 4;
                    out[di..di + 4].copy_from_slice(&src[si..si + 4]);
                }
            }
        };
    // Right leg → left leg
    copy_face(&mut out, 4, 16, 4, 4, 20, 48);
    copy_face(&mut out, 8, 16, 4, 4, 24, 48);
    copy_face(&mut out, 0, 20, 4, 12, 24, 52);
    copy_face(&mut out, 4, 20, 4, 12, 20, 52);
    copy_face(&mut out, 8, 20, 4, 12, 16, 52);
    copy_face(&mut out, 12, 20, 4, 12, 28, 52);
    // Right arm → left arm
    copy_face(&mut out, 44, 16, 4, 4, 36, 48);
    copy_face(&mut out, 48, 16, 4, 4, 40, 48);
    copy_face(&mut out, 40, 20, 4, 12, 40, 52);
    copy_face(&mut out, 44, 20, 4, 12, 36, 52);
    copy_face(&mut out, 48, 20, 4, 12, 32, 52);
    copy_face(&mut out, 52, 20, 4, 12, 44, 52);
    out
}

fn scale_region(r: (usize, usize, usize, usize), width: usize) -> (usize, usize, usize, usize) {
    (
        map64(r.0, width),
        map64(r.1, width),
        map64(r.2, width),
        map64(r.3, width),
    )
}

/// Legacy 64×32 skins (e.g. Notch) paint unused/hat areas opaque black.
/// If the top-right 32×32 has no real transparency, clear it (MC compatibility).
fn apply_notch_transparency_hack(rgba: &mut [u8], width: usize) {
    let x0 = map64(32, width);
    let y0 = 0;
    let x1 = map64(64, width);
    let y1 = map64(32, width);
    for y in y0..y1 {
        for x in x0..x1 {
            let i = (y * width + x) * 4;
            if rgba[i + 3] < 128 {
                return;
            }
        }
    }
    // Only clear alpha — RGB must stay so restore keeps arm/body colors.
    for y in y0..y1 {
        for x in x0..x1 {
            let i = (y * width + x) * 4;
            rgba[i + 3] = 0;
        }
    }
    for &r in &NOTCH_RESTORE_64 {
        let (rx0, ry0, rx1, ry1) = scale_region(r, width);
        for y in ry0..ry1 {
            for x in rx0..rx1 {
                let i = (y * width + x) * 4;
                rgba[i + 3] = 0xff;
            }
        }
    }
}

fn apply_alpha_rules(
    rgba: &mut [u8],
    width: usize,
    height: usize,
    semi_transparent: bool,
) {
    let base_regions: Vec<_> = BASE_REGIONS_64
        .iter()
        .map(|&r| scale_region(r, width))
        .collect();
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) * 4;
            if !semi_transparent {
                let in_base = base_regions.iter().any(|&r| in_region(x, y, r));
                if in_base {
                    rgba[i + 3] = 0xff;
                }
            }
            if rgba[i + 3] == 0 {
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
            }
        }
    }
}

pub fn detect_skin_model(rgba: &[u8], width: u32, height: u32) -> SkinModel {
    if width != height || !(64..=MAX_TEXTURE_SIZE).contains(&width) {
        return SkinModel::Classic;
    }
    let w = width as usize;
    let x0 = map64(46, w);
    let x1 = map64(48, w);
    let y0 = map64(20, w);
    let y1 = map64(32, w);
    let mut opaque = 0usize;
    let mut total = 0usize;
    for y in y0..y1 {
        for x in x0..x1 {
            let i = (y * w + x) * 4;
            if i + 3 >= rgba.len() {
                continue;
            }
            total += 1;
            if rgba[i + 3] > 0 {
                opaque += 1;
            }
        }
    }
    if total == 0 {
        return SkinModel::Classic;
    }
    let threshold = (total / 4).max(1);
    if opaque < threshold {
        SkinModel::Slim
    } else {
        SkinModel::Classic
    }
}

fn is_supported_skin_size(width: u32, height: u32) -> bool {
    if !(64..=MAX_TEXTURE_SIZE).contains(&width) || height == 0 {
        return false;
    }
    // Square, or classic half-height (width == 2 * height). No multiple-of-64 requirement.
    height == width || height == width / 2
}

pub fn normalize_png(buf: &[u8]) -> Result<NormalizedPng, NormalizeError> {
    normalize_png_opts(buf, false)
}

pub fn normalize_png_opts(
    buf: &[u8],
    semi_transparent: bool,
) -> Result<NormalizedPng, NormalizeError> {
    if buf.len() > limits::PNG_BYTES {
        return Err(NormalizeError::new(
            "PAYLOAD_TOO_LARGE",
            format!("PNG {} bytes exceeds {}", buf.len(), limits::PNG_BYTES),
        ));
    }
    let head = inspect_png(buf)?;
    if head.is_apng {
        return Err(NormalizeError::new(
            "APNG_NOT_SUPPORTED",
            "APNG is not supported",
        ));
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
    if !is_supported_skin_size(head.width, head.height) {
        return Err(NormalizeError::new(
            "BAD_DIMENSIONS",
            format!(
                "dimensions {}x{}; need square (N×N) or half-height (N×N/2) with N∈[64…{MAX_TEXTURE_SIZE}]",
                head.width, head.height
            ),
        ));
    }

    let is_half_height = head.height == head.width / 2;
    let max_rgba = (MAX_TEXTURE_SIZE as usize) * (MAX_TEXTURE_SIZE as usize) * 4;

    let mut decoder = png::Decoder::new(std::io::Cursor::new(buf));
    decoder.set_transformations(png::Transformations::EXPAND);
    decoder.set_limits(png::Limits { bytes: max_rgba });
    let mut reader = decoder
        .read_info()
        .map_err(|e| NormalizeError::new("BAD_PNG", format!("decode failed: {e}")))?;
    let mut buf_rgba = vec![0u8; reader.output_buffer_size().unwrap_or(RGBA_LENGTH)];
    let info = reader
        .next_frame(&mut buf_rgba)
        .map_err(|e| NormalizeError::new("BAD_PNG", format!("decode failed: {e}")))?;
    let used = info.buffer_size();
    buf_rgba.truncate(used);
    let expected_raw = head.width as usize * head.height as usize * 4;
    let src = to_rgba8(&buf_rgba, info.color_type);
    if src.len() != expected_raw {
        return Err(NormalizeError::new(
            "BAD_PNG",
            format!("decoded to {} bytes, expected {expected_raw}", src.len()),
        ));
    }

    let flags = if semi_transparent {
        FLAG_SEMI_TRANSPARENT
    } else {
        0
    };

    let (mut rgba, texture_width, texture_height) = if is_half_height {
        let w = head.width as usize;
        let mut expanded = expand_half_height(&src, w);
        apply_notch_transparency_hack(&mut expanded, w);
        (expanded, head.width, head.width)
    } else {
        (src, head.width, head.height)
    };
    apply_alpha_rules(
        &mut rgba,
        texture_width as usize,
        texture_height as usize,
        semi_transparent,
    );

    let detected_model = if is_half_height && texture_width == 64 {
        SkinModel::Classic
    } else {
        detect_skin_model(&rgba, texture_width, texture_height)
    };

    Ok(NormalizedPng {
        rgba,
        was_legacy: is_half_height,
        texture_width,
        texture_height,
        flags,
        detected_model,
    })
}

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
        png::ColorType::Indexed => raw.to_vec(),
    }
}

#[derive(Debug)]
pub struct NormalizedPng {
    pub rgba: Vec<u8>,
    pub was_legacy: bool,
    pub texture_width: u32,
    pub texture_height: u32,
    pub flags: u8,
    pub detected_model: SkinModel,
}

pub fn rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, NormalizeError> {
    let expected = width as usize * height as usize * 4;
    if rgba.len() != expected {
        return Err(NormalizeError::new(
            "BAD_DIMENSIONS",
            format!("rgba must be {expected} bytes"),
        ));
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
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

/// Encode 64×64 preview helper.
pub fn rgba_to_png_64(rgba: &[u8]) -> Result<Vec<u8>, NormalizeError> {
    rgba_to_png(rgba, SKIN_WIDTH as u32, SKIN_HEIGHT as u32)
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
        let png = rgba_to_png_64(&rgba).unwrap();
        let back = normalize_png(&png).unwrap();
        assert!(!back.was_legacy);
        assert_eq!(back.texture_width, 64);
        assert_eq!(back.texture_height, 64);
        assert_eq!(back.flags, 0);
        assert_eq!(back.rgba, rgba);
    }

    #[test]
    fn accepts_hd_full_res() {
        let mut out = Vec::new();
        let side = 128u32;
        let pixels = vec![0u8; (side * side * 4) as usize];
        {
            let mut encoder = png::Encoder::new(&mut out, side, side);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
        }
        let back = normalize_png(&out).unwrap();
        assert_eq!(back.texture_width, 128);
        assert_eq!(back.texture_height, 128);
        assert_eq!(back.rgba.len(), 128 * 128 * 4);
    }

    #[test]
    fn notch_opaque_hat_zone_cleared() {
        // Fully opaque 64×32 with black junk in top-right (Notch-style).
        let mut pixels = vec![255u8; 64 * 32 * 4];
        for i in (0..pixels.len()).step_by(4) {
            pixels[i] = 40;
            pixels[i + 1] = 30;
            pixels[i + 2] = 20;
            pixels[i + 3] = 255;
        }
        // Opaque black in hat / unused zone
        for y in 0..32 {
            for x in 32..64 {
                let i = (y * 64 + x) * 4;
                pixels[i] = 0;
                pixels[i + 1] = 0;
                pixels[i + 2] = 0;
                pixels[i + 3] = 255;
            }
        }
        // Distinct color on right-arm front so restore must keep it
        for y in 20..32 {
            for x in 44..48 {
                let i = (y * 64 + x) * 4;
                pixels[i] = 10;
                pixels[i + 1] = 200;
                pixels[i + 2] = 10;
                pixels[i + 3] = 255;
            }
        }
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 64, 32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
        }
        let n = normalize_png(&out).unwrap();
        assert!(n.was_legacy);
        // Hat overlay pixel cleared
        let hat = (0 * 64 + 40) * 4;
        assert_eq!(&n.rgba[hat..hat + 4], &[0, 0, 0, 0]);
        // Right arm restored opaque with color
        let arm = (20 * 64 + 44) * 4;
        assert_eq!(&n.rgba[arm..arm + 4], &[10, 200, 10, 255]);
    }

    #[test]
    fn half_height_mirrors_faces_not_blocks() {
        // Paint distinct colors on right-leg faces; expect correct left-leg UV after expand.
        let mut pixels = vec![0u8; 64 * 32 * 4];
        let put = |px: &mut [u8], x: usize, y: usize, r: u8, g: u8, b: u8| {
            let i = (y * 64 + x) * 4;
            px[i] = r;
            px[i + 1] = g;
            px[i + 2] = b;
            px[i + 3] = 255;
        };
        // Outer face (0,20): red — should land flipped at left face (24,52)
        put(&mut pixels, 0, 20, 255, 0, 0);
        put(&mut pixels, 3, 20, 200, 0, 0);
        // Inner face (8,20): green — should land flipped at right face (16,52)
        put(&mut pixels, 8, 20, 0, 255, 0);
        put(&mut pixels, 11, 20, 0, 200, 0);
        // Top (4,16): blue — should land flipped at (20,48)
        put(&mut pixels, 4, 16, 0, 0, 255);
        put(&mut pixels, 7, 16, 0, 0, 200);

        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 64, 32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
        }
        let n = normalize_png(&out).unwrap();
        assert!(n.was_legacy);
        let get = |x: usize, y: usize| {
            let i = (y * 64 + x) * 4;
            [
                n.rgba[i],
                n.rgba[i + 1],
                n.rgba[i + 2],
                n.rgba[i + 3],
            ]
        };
        // Outer src x=0 → dest left face x=24+(3-0)=27; src x=3 → dest x=24
        assert_eq!(get(27, 52), [255, 0, 0, 255]);
        assert_eq!(get(24, 52), [200, 0, 0, 255]);
        // Inner src x=8 → dest right face x=16+3=19; src x=11 → dest x=16
        assert_eq!(get(19, 52), [0, 255, 0, 255]);
        assert_eq!(get(16, 52), [0, 200, 0, 255]);
        // Top src x=4 → dest x=20+3=23; src x=7 → dest x=20
        assert_eq!(get(23, 48), [0, 0, 255, 255]);
        assert_eq!(get(20, 48), [0, 0, 200, 255]);
    }

    #[test]
    fn accepts_half_height_hd_128x64() {
        let mut out = Vec::new();
        let w = 128u32;
        let h = 64u32;
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        // Mark a top-half pixel so we can assert it survives expand.
        let i = (10 * w + 10) as usize * 4;
        pixels[i] = 1;
        pixels[i + 1] = 2;
        pixels[i + 2] = 3;
        pixels[i + 3] = 255;
        {
            let mut encoder = png::Encoder::new(&mut out, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
        }
        let back = normalize_png(&out).unwrap();
        assert!(back.was_legacy);
        assert_eq!(back.texture_width, 128);
        assert_eq!(back.texture_height, 128);
        assert_eq!(back.rgba.len(), 128 * 128 * 4);
        assert_eq!(&back.rgba[i..i + 4], &[1, 2, 3, 255]);
    }

    #[test]
    fn semi_transparent_keeps_mid_alpha() {
        let mut rgba = sample_rgba();
        // Overlay pixel (outside base) with mid alpha.
        let i = (2 * 64 + 2) * 4;
        rgba[i] = 10;
        rgba[i + 1] = 20;
        rgba[i + 2] = 30;
        rgba[i + 3] = 128;
        let png = rgba_to_png_64(&rgba).unwrap();
        let back = normalize_png_opts(&png, true).unwrap();
        assert_eq!(back.flags, FLAG_SEMI_TRANSPARENT);
        assert_eq!(back.rgba[i + 3], 128);
    }

    #[test]
    fn rejects_not_png() {
        let err = normalize_png(b"not a png at all").unwrap_err();
        assert_eq!(err.code, "NOT_PNG");
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
    fn accepts_non_multiple_of_64_square() {
        // 96×96 is valid; width need not be a multiple of 64.
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 96, 96);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[0u8; 96 * 96 * 4]).unwrap();
        }
        let n = normalize_png(&out).unwrap();
        assert_eq!(n.texture_width, 96);
        assert_eq!(n.texture_height, 96);
    }

    #[test]
    fn detects_slim_when_arm_strip_empty() {
        let mut rgba = sample_rgba();
        for y in 20..32 {
            for x in 46..48 {
                let i = (y * 64 + x) * 4;
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
                rgba[i + 3] = 0;
            }
        }
        assert_eq!(detect_skin_model(&rgba, 64, 64), SkinModel::Slim);
    }
}
