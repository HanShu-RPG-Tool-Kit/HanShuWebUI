//! Golden / codec integration against PNG+RGBA fixtures.
//! skinId is sha256(C) without model; share string carries model separately.

use skin_core::codec::{
    build_c, decode_share_code, encode_share_code, skin_id_of, DecodedSkin, SkinModel,
};
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

#[test]
fn png_normalize_matches_rgba_fixture() {
    for case in cases() {
        let png = std::fs::read(fixture(&format!("{case}.png"))).unwrap();
        let expected_rgba = std::fs::read(fixture(&format!("{case}.rgba"))).unwrap();
        let normalized = normalize_png(&png).expect(&case);
        assert_eq!(normalized.rgba, expected_rgba, "rgba mismatch for {case}");
        assert_eq!(
            normalized.was_legacy,
            case.contains("legacy"),
            "legacy flag mismatch for {case}"
        );
        assert_eq!(normalized.texture_width, 64);
        assert_eq!(normalized.texture_height, 64);
    }
}

#[test]
fn share_round_trip_model_not_in_skin_id() {
    for case in cases() {
        let expected_rgba = std::fs::read(fixture(&format!("{case}.rgba"))).unwrap();
        let decoded = DecodedSkin {
            rgba: expected_rgba.clone(),
            width: 64,
            height: 64,
            flags: 0,
        };
        let model = model_of(&case);
        let code = encode_share_code(model, &decoded).unwrap();
        assert!(code.starts_with("hanshu-skin:1:"));
        let (back, got_model, skin_id) = decode_share_code(&code).unwrap();
        assert_eq!(got_model, model);
        assert_eq!(back.rgba, expected_rgba);
        assert_eq!(skin_id.len(), 64);

        let c = build_c(0, 64, 64, &expected_rgba).unwrap();
        assert_eq!(skin_id_of(&c), skin_id);

        // Same pixels, other model → same skinId.
        let other = if model == SkinModel::Classic {
            SkinModel::Slim
        } else {
            SkinModel::Classic
        };
        let code2 = encode_share_code(other, &decoded).unwrap();
        let (_, _, id2) = decode_share_code(&code2).unwrap();
        assert_eq!(skin_id, id2, "model must not change skinId for {case}");
    }
}

#[test]
fn png_encoder_round_trip() {
    for case in cases() {
        let expected_rgba = std::fs::read(fixture(&format!("{case}.rgba"))).unwrap();
        let png = rgba_to_png(&expected_rgba, 64, 64).unwrap();
        let back = normalize_png(&png).unwrap();
        assert_eq!(back.rgba, expected_rgba, "encoder round-trip for {case}");
    }
}
