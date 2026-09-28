use serde::{Deserialize, Serialize};

pub const CANVAS_W: f64 = 1080.0;
pub const CANVAS_H: f64 = 1920.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    Cover,
    Contain,
}

fn default_fit() -> Fit {
    Fit::Cover
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Border {
    pub width: f64,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layer {
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub src: [f64; 4],
    pub dst: [f64; 4],
    #[serde(default = "default_fit")]
    pub fit: Fit,
    #[serde(default)]
    pub radius: Option<f64>,
    #[serde(default)]
    pub border: Option<Border>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Background {
    Blur { amount: f64 },
    Color { color: String },
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetAudioTrack {
    pub label: String,
    pub enabled: bool,
    pub gain: f64,
    pub ceiling_db: Option<f64>,
    pub offset_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetDuck {
    pub targets: Vec<String>,
    pub triggers: Vec<String>,
    pub amount_db: f64,
    pub threshold_db: f64,
    pub release_s: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresetAudio {
    pub tracks: Vec<PresetAudioTrack>,
    #[serde(default)]
    pub duck: Option<PresetDuck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub game: String,
    pub version: u32,
    #[serde(default)]
    pub builtin: bool,
    pub background: Background,
    pub layers: Vec<Layer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<PresetAudio>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayerLayout {
    pub crop: [i64; 4],
    pub draw: [i64; 4],
}

pub fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

pub fn in_range(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && v >= lo && v <= hi
}

fn is_label(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 64
}

pub fn validate_preset_audio(a: &PresetAudio) -> Result<(), String> {
    for t in &a.tracks {
        if !is_label(&t.label) {
            return Err("audio track label must be 1-64 characters".into());
        }
        if !in_range(t.gain, 0.0, 2.0) {
            return Err(format!("audio track {}: gain must be 0-2", t.label));
        }
        if let Some(c) = t.ceiling_db {
            if !in_range(c, -24.0, 0.0) {
                return Err(format!("audio track {}: ceiling must be -24 to 0 dB", t.label));
            }
        }
        if !in_range(t.offset_s, -2.0, 2.0) {
            return Err(format!("audio track {}: offset must be -2 to 2 s", t.label));
        }
    }
    if let Some(d) = &a.duck {
        if !d.targets.iter().chain(&d.triggers).all(|l| is_label(l)) {
            return Err("duck targets/triggers must be track labels".into());
        }
        if !in_range(d.amount_db, -24.0, 0.0) {
            return Err("duck amount must be -24 to 0 dB".into());
        }
        if !in_range(d.threshold_db, -60.0, 0.0) {
            return Err("duck threshold must be -60 to 0 dB".into());
        }
        if !in_range(d.release_s, 0.05, 2.0) {
            return Err("duck release must be 0.05 to 2 s".into());
        }
    }
    Ok(())
}

pub fn validate(p: &Preset) -> Result<(), String> {
    validate_on(p, CANVAS_W, CANVAS_H)
}

pub fn validate_on(p: &Preset, canvas_w: f64, canvas_h: f64) -> Result<(), String> {
    if p.version != 1 {
        return Err(format!("unsupported preset version {}", p.version));
    }
    if p.layers.is_empty() {
        return Err("preset needs at least one layer".into());
    }
    match &p.background {
        Background::Blur { amount } if !(0.0..=100.0).contains(amount) => return Err("blur amount must be 0-100".into()),
        Background::Color { color } if !is_hex_color(color) => return Err(format!("bad background color {color}")),
        _ => {}
    }
    let mut seen = std::collections::HashSet::new();
    for l in &p.layers {
        if !seen.insert(l.id.as_str()) {
            return Err(format!("duplicate layer id {}", l.id));
        }
        let [x, y, w, h] = l.src;
        if !(x >= 0.0 && y >= 0.0 && w > 0.0 && h > 0.0 && x + w <= 1.0 + 1e-6 && y + h <= 1.0 + 1e-6) {
            return Err(format!("layer {}: src outside frame", l.id));
        }
        let [dx, dy, dw, dh] = l.dst;
        if !(dx >= 0.0 && dy >= 0.0 && dw >= 1.0 && dh >= 1.0 && dx + dw <= canvas_w && dy + dh <= canvas_h) {
            return Err(format!("layer {}: dst outside canvas", l.id));
        }
        if let Some(r) = l.radius {
            if !(r >= 0.0 && r.is_finite()) {
                return Err(format!("layer {}: radius must be >= 0", l.id));
            }
        }
        if let Some(b) = &l.border {
            if !(b.width > 0.0 && is_hex_color(&b.color)) {
                return Err(format!("layer {}: bad border", l.id));
            }
        }
    }
    if !p.layers.iter().any(|l| !l.hidden) {
        return Err("preset needs at least one visible layer".into());
    }
    if let Some(a) = &p.audio {
        validate_preset_audio(a)?;
    }
    Ok(())
}

fn r(v: f64) -> i64 {
    v.round() as i64
}

/// ffmpeg overlays on yuv420p snap to even x/y, so positions are even on both sides.
fn even(v: i64) -> i64 {
    2 * r(v as f64 / 2.0)
}

/// ffmpeg cannot crop a 1px region from yuv420p.
const MIN_CROP: i64 = 2;

/// Mirrors src/render/fit.ts `layoutLayer` exactly. Change both together.
pub fn layout_layer(src: [f64; 4], dst: [f64; 4], fit: Fit, sw: i64, sh: i64) -> LayerLayout {
    let mut x = r(src[0] * sw as f64).clamp(0, sw - MIN_CROP);
    let mut y = r(src[1] * sh as f64).clamp(0, sh - MIN_CROP);
    let mut w = r(src[2] * sw as f64).clamp(MIN_CROP, sw - x);
    let mut h = r(src[3] * sh as f64).clamp(MIN_CROP, sh - y);
    let (dx, dy, dw, dh) = (r(dst[0]), r(dst[1]), r(dst[2]), r(dst[3]));
    match fit {
        Fit::Cover => {
            let a = dw as f64 / dh as f64;
            if w as f64 / h as f64 > a {
                let nw = r(h as f64 * a).max(MIN_CROP);
                x += r((w - nw) as f64 / 2.0);
                w = nw;
            } else {
                let nh = r(w as f64 / a).max(MIN_CROP);
                y += r((h - nh) as f64 / 2.0);
                h = nh;
            }
            LayerLayout { crop: [x, y, w, h], draw: [even(dx), even(dy), dw, dh] }
        }
        Fit::Contain => {
            let s = (dw as f64 / w as f64).min(dh as f64 / h as f64);
            let draw_w = r(w as f64 * s).max(1);
            let draw_h = r(h as f64 * s).max(1);
            LayerLayout {
                crop: [x, y, w, h],
                draw: [even(dx + r((dw - draw_w) as f64 / 2.0)), even(dy + r((dh - draw_h) as f64 / 2.0)), draw_w, draw_h],
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Preset {
        serde_json::from_str(include_str!("../../src/test/fixtures/preset-fixture.json")).unwrap()
    }

    #[test]
    fn parses_and_validates_fixture() {
        let p = fixture();
        assert_eq!(p.layers.len(), 2);
        assert_eq!(p.layers[1].fit, Fit::Contain);
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn rejects_bad_presets() {
        let mut p = fixture();
        p.layers[0].src = [0.8, 0.0, 0.3, 1.0];
        assert!(validate(&p).unwrap_err().contains("src outside frame"));

        let mut p = fixture();
        p.layers[0].dst = [0.0, 1800.0, 1080.0, 200.0];
        assert!(validate(&p).unwrap_err().contains("dst outside canvas"));

        let mut p = fixture();
        p.layers[0].src[0] = f64::NAN;
        assert!(validate(&p).is_err());

        let mut p = fixture();
        p.background = Background::Color { color: "red;drawbox".into() };
        assert!(validate(&p).is_err());

        let mut p = fixture();
        p.layers[1].id = "gameplay".into();
        assert!(validate(&p).unwrap_err().contains("duplicate layer id"));

        let mut p = fixture();
        p.version = 2;
        assert!(validate(&p).is_err());
    }

    #[test]
    fn full_frame_landscape_layer_is_valid_on_its_canvas_only() {
        let mut p = fixture();
        p.layers.truncate(1);
        p.layers[0].dst = [0.0, 0.0, 2560.0, 1440.0];
        assert!(validate_on(&p, 2560.0, 1440.0).is_ok());
        assert!(validate(&p).unwrap_err().contains("dst outside canvas"));
    }

    #[test]
    fn layout_cover_matches_ts() {
        let l = layout_layer([0.28, 0.0, 0.44, 1.0], [0.0, 420.0, 1080.0, 1080.0], Fit::Cover, 1920, 1080);
        assert_eq!(l, LayerLayout { crop: [538, 118, 845, 845], draw: [0, 420, 1080, 1080] });
    }

    #[test]
    fn layout_contain_matches_ts() {
        let l = layout_layer([0.75, 0.02, 0.23, 0.15], [60.0, 80.0, 960.0, 300.0], Fit::Contain, 1920, 1080);
        assert_eq!(l, LayerLayout { crop: [1440, 22, 442, 162], draw: [132, 80, 819, 300] });
    }

    #[test]
    fn layout_full_frame_cover_matches_ts() {
        let l = layout_layer([0.0, 0.0, 1.0, 1.0], [0.0, 0.0, 1080.0, 1920.0], Fit::Cover, 1920, 1080);
        assert_eq!(l.crop, [656, 0, 608, 1080]);
    }

    #[test]
    fn edge_clamp_matches_ts() {
        let l = layout_layer([0.5, 0.5, 0.5, 0.5], [0.0, 0.0, 1080.0, 1920.0], Fit::Contain, 2559, 1439);
        assert_eq!(l, LayerLayout { crop: [1280, 720, 1279, 719], draw: [0, 658, 1080, 607] });
    }

    #[test]
    fn draw_is_even_and_crop_at_least_2px_matches_ts() {
        let l = layout_layer([0.999, 0.999, 0.001, 0.001], [101.0, 203.0, 300.0, 300.0], Fit::Contain, 1920, 1080);
        assert_eq!(l.draw[0] % 2, 0);
        assert_eq!(l.draw[1] % 2, 0);
        assert!(l.crop[2] >= 2 && l.crop[3] >= 2);
        assert!(l.crop[0] + l.crop[2] <= 1920 && l.crop[1] + l.crop[3] <= 1080);
    }

    #[test]
    fn hidden_round_trips_and_is_omitted_when_false() {
        let mut p = fixture();
        assert!(!serde_json::to_string(&p).unwrap().contains("hidden"));
        p.layers[1].hidden = true;
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"hidden\":true"));
        let back: Preset = serde_json::from_str(&json).unwrap();
        assert!(back.layers[1].hidden);
        assert!(!back.layers[0].hidden);
    }

    #[test]
    fn rejects_all_hidden_layers() {
        let mut p = fixture();
        for l in &mut p.layers {
            l.hidden = true;
        }
        assert!(validate(&p).unwrap_err().contains("at least one visible layer"));
    }

    #[test]
    fn builtin_wardogs_is_valid() {
        let p: Preset = serde_json::from_str(include_str!("../../src/presets/builtin/wardogs.json")).unwrap();
        assert!(validate(&p).is_ok());
    }

    fn audio() -> PresetAudio {
        serde_json::from_str(r#"{"tracks":[{"label":"Game","enabled":true,"gain":1.2,"ceilingDb":-3,"offsetS":0.05}],
            "duck":{"targets":["Game"],"triggers":["Discord"],"amountDb":-10,"thresholdDb":-40,"releaseS":0.4}}"#).unwrap()
    }

    #[test]
    fn preset_audio_validates() {
        assert!(validate_preset_audio(&audio()).is_ok());
        let mut p = fixture();
        p.audio = Some(audio());
        assert!(validate(&p).is_ok());
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"ceilingDb\":-3"));
        assert!(!serde_json::to_string(&fixture()).unwrap().contains("audio"));
    }

    #[test]
    fn preset_audio_rejects_out_of_range() {
        let mut a = audio();
        a.tracks[0].gain = 2.5;
        assert!(validate_preset_audio(&a).unwrap_err().contains("gain"));
        let mut a = audio();
        a.tracks[0].ceiling_db = Some(-30.0);
        assert!(validate_preset_audio(&a).unwrap_err().contains("ceiling"));
        let mut a = audio();
        a.tracks[0].offset_s = f64::NAN;
        assert!(validate_preset_audio(&a).unwrap_err().contains("offset"));
        let mut a = audio();
        a.duck.as_mut().unwrap().release_s = 0.0;
        assert!(validate_preset_audio(&a).unwrap_err().contains("release"));
        let mut a = audio();
        a.tracks[0].label = String::new();
        assert!(validate_preset_audio(&a).unwrap_err().contains("label"));
    }
}
