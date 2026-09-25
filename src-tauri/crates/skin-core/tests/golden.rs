//! Cross-language golden fixtures: every case was exported by the Node
//! implementation (skin-manager/scripts/export-fixtures.mjs). Rust must
//! produce byte-identical rgba, skinId and a mutually decodable skin code.

use skin_core::codec::{build_p, decode_skin_code, encode_skin_code, skin_id_of, SkinModel};
use skin_core::normalize::{normalize_png, rgba_to_png};

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn model_of(name: &str) -> SkinModel {
    if name.contains("slim") {
        SkinModel::Slim
    } else {
        SkinModel::Classic
    }
}

#[test]
fn node_png_to_rust_rgba_and_skin_id() {
    for case in cases() {
        let png = std::fs::read(fixture(&format!("{case}.png"))).unwrap();
        let expected_rgba = std::fs::read(fixture(&format!("{case}.rgba"))).unwrap();
        let expected_id = std::fs::read_to_string(fixture(&format!("{case}.skinid")))
            .unwrap()
            .trim()
            .to_string();

        let normalized = normalize_png(&png).expect(&case);
        assert_eq!(normalized.rgba, expected_rgba, "rgba mismatch for {case}");
        assert_eq!(
            normalized.was_legacy,
            case.contains("legacy"),
            "legacy flag mismatch for {case}"
        );

        let p = build_p(model_of(&case), &normalized.rgba).unwrap();
        assert_eq!(skin_id_of(&p), expected_id, "skinId mismatch for {case}");
    }
}

#[test]
fn node_skin_code_decodes_in_rust() {
    for case in cases() {
        let code = std::fs::read_to_string(fixture(&format!("{case}.skincode")))
            .unwrap()
            .trim()
            .to_string();
        let expected_id = std::fs::read_to_string(fixture(&format!("{case}.skinid")))
            .unwrap()
            .trim()
            .to_string();
        let expected_rgba = std::fs::read(fixture(&format!("{case}.rgba"))).unwrap();

        let (decoded, skin_id) = decode_skin_code(&code).expect(&case);
        assert_eq!(skin_id, expected_id, "skinId mismatch for {case}");
        assert_eq!(decoded.rgba, expected_rgba, "rgba mismatch for {case}");
        assert_eq!(decoded.model, model_of(&case), "model mismatch for {case}");
    }
}

#[test]
fn rust_skin_code_decodes_with_same_id() {
    // Rust encode → verify P/skinId identical to Node's (compression bytes
    // may differ; P and SHA-256(P) must not).
    for case in cases() {
        let expected_rgba = std::fs::read(fixture(&format!("{case}.rgba"))).unwrap();
        let expected_id = std::fs::read_to_string(fixture(&format!("{case}.skinid")))
            .unwrap()
            .trim()
            .to_string();
        let code = encode_skin_code(model_of(&case), &expected_rgba).unwrap();
        let (_, skin_id) = decode_skin_code(&code).unwrap();
        assert_eq!(skin_id, expected_id, "round-trip skinId mismatch for {case}");
    }
}

#[test]
fn rust_png_encoder_matches_decoded_rgba() {
    // Compare decoded RGBA, not PNG file bytes (compression may differ).
    for case in cases() {
        let expected_rgba = std::fs::read(fixture(&format!("{case}.rgba"))).unwrap();
        let png = rgba_to_png(&expected_rgba).unwrap();
        let back = normalize_png(&png).unwrap();
        assert_eq!(back.rgba, expected_rgba, "encoder round-trip for {case}");
    }
}

fn cases() -> Vec<String> {
    let meta: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture("fixtures.json")).unwrap())
            .unwrap();
    meta["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap().to_string())
        .collect()
}
