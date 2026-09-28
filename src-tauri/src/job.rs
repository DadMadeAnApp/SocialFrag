use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::audio_mix::AudioMix;
use crate::preset::Preset;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackInfo {
    pub index: u32,
    pub label: String,
    pub named: bool,
    pub channels: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub width: u32,
    pub height: u32,
    pub fps: String,
    pub codec: String,
    /// Container codec tag, e.g. "hev1" / "hvc1" / "avc1". WebKit can't decode hev1 even though it plays hvc1.
    #[serde(default)]
    pub codec_tag: String,
    pub duration: f64,
    pub has_audio: bool,
    #[serde(default)]
    pub audio_tracks: Vec<AudioTrackInfo>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trim {
    pub in_s: f64,
    pub out_s: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    High,
    Small,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub png_base64: String,
    pub start: f64,
}

/// A stretch of the clip's output (seconds) showing one caption image. Frames are contiguous from 0.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionFrame {
    pub png_base64: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    #[default]
    Video,
    /// One source frame (at trim.in_s) held for trim.out_s - trim.in_s seconds.
    Freeze,
}

fn one() -> f64 {
    1.0
}

/// One timeline clip: source window, layout and audio. Overlay starts are seconds into the clip's output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipJob {
    #[serde(default)]
    pub kind: ClipKind,
    pub source: String,
    pub clip: ClipInfo,
    pub preset: Preset,
    pub trim: Trim,
    #[serde(default = "one")]
    pub speed: f64,
    pub layer_masks: HashMap<String, String>,
    pub overlays: Vec<Overlay>,
    #[serde(default)]
    pub caption_frames: Vec<CaptionFrame>,
    #[serde(default)]
    pub audio: AudioMix,
    /// track index -> base64 f32le gain samples at 200 Hz covering the trim (source time)
    #[serde(default)]
    pub gain_curves: HashMap<u32, String>,
}

impl ClipJob {
    /// Output seconds this clip occupies. Mirrors TS `clipDuration`.
    pub fn duration(&self) -> f64 {
        match self.kind {
            ClipKind::Freeze => self.trim.out_s - self.trim.in_s,
            ClipKind::Video => (self.trim.out_s - self.trim.in_s) / self.speed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Canvas {
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub clips: Vec<ClipJob>,
    pub quality: Quality,
    pub fps: u32,
    pub canvas: Canvas,
    /// Chosen in the Save dialog; `.mp4` is added when missing.
    pub output_path: String,
}

impl ExportJob {
    pub fn duration(&self) -> f64 {
        self.clips.iter().map(ClipJob::duration).sum()
    }
}

pub const ALLOWED_CANVASES: [Canvas; 3] = [Canvas { w: 1080, h: 1920 }, Canvas { w: 1920, h: 1080 }, Canvas { w: 2560, h: 1440 }];

pub const MAX_CLIPS: usize = 200;
pub const MAX_FREEZE_S: f64 = 60.0;
/// Source durations from ffprobe are rounded; allow an out point this far past them.
const DURATION_SLACK_S: f64 = 0.05;

pub fn validate_job(job: &ExportJob) -> Result<(), String> {
    if job.clips.is_empty() || job.clips.len() > MAX_CLIPS {
        return Err(format!("a timeline needs 1 to {MAX_CLIPS} clips"));
    }
    if job.fps != 30 && job.fps != 60 {
        return Err(format!("fps must be 30 or 60, got {}", job.fps));
    }
    if !ALLOWED_CANVASES.contains(&job.canvas) {
        return Err("output must be 1080x1920, 1920x1080 or 2560x1440".into());
    }
    for (n, c) in job.clips.iter().enumerate() {
        validate_clip(c).map_err(|e| format!("clip {}: {e}", n + 1))?;
    }
    Ok(())
}

fn validate_clip(c: &ClipJob) -> Result<(), String> {
    let (i, o) = (c.trim.in_s, c.trim.out_s);
    if !(i.is_finite() && o.is_finite() && i >= 0.0 && o > i) {
        return Err("in/out out of range".into());
    }
    match c.kind {
        ClipKind::Video => {
            if o > c.clip.duration + DURATION_SLACK_S {
                return Err("in/out out of range".into());
            }
            if !crate::preset::in_range(c.speed, 0.25, 4.0) {
                return Err("speed must be 0.25 to 4".into());
            }
        }
        ClipKind::Freeze => {
            if i >= c.clip.duration - 0.01 || o - i > MAX_FREEZE_S || c.speed != 1.0 {
                return Err(format!("freeze frame must be inside the source, at most {MAX_FREEZE_S} s long, at speed 1"));
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub fraction: f64,
    pub eta_s: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: String,
    pub used_cpu_fallback: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportError {
    pub code: String,
    pub message: String,
    pub details: String,
}

impl ExportError {
    pub fn new(code: &str, message: &str, details: &str) -> Self {
        Self { code: code.into(), message: message.into(), details: details.into() }
    }
}

#[cfg(test)]
pub mod fixtures {
    use super::*;

    pub fn clip() -> ClipJob {
        ClipJob {
            kind: ClipKind::Video,
            source: "C:/clips/in.mp4".into(),
            clip: ClipInfo { width: 1920, height: 1080, fps: "60".into(), codec: "h264".into(), codec_tag: "avc1".into(), duration: 30.0, has_audio: true, audio_tracks: vec![] },
            preset: serde_json::from_str(include_str!("../../src/test/fixtures/preset-fixture.json")).unwrap(),
            trim: Trim { in_s: 1.0, out_s: 11.0 },
            speed: 1.0,
            layer_masks: HashMap::new(),
            overlays: vec![],
            caption_frames: vec![],
            audio: AudioMix::default(),
            gain_curves: HashMap::new(),
        }
    }

    pub fn job() -> ExportJob {
        ExportJob { clips: vec![clip()], quality: Quality::High, fps: 60, canvas: Canvas { w: 1080, h: 1920 }, output_path: "C:/clips/in_vertical.mp4".into() }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{clip, job};
    use super::*;

    #[test]
    fn deserializes_ts_shaped_json() {
        let json = r#"{"clips":[{"kind":"freeze","source":"C:/a.mp4","clip":{"width":1920,"height":1080,"fps":"60","codec":"h264","duration":5,"hasAudio":false},
          "preset":{"id":"p","name":"P","version":1,"background":{"type":"none"},"layers":[{"id":"g","src":[0,0,1,1],"dst":[0,0,1080,1920]}]},
          "trim":{"inS":1,"outS":4},"speed":1,"layerMasks":{},"overlays":[{"pngBase64":"AA==","start":1.5}],"audio":{"tracks":[],"duck":null},"gainCurves":{}}],
          "quality":"small","fps":30,"canvas":{"w":1080,"h":1920},"outputPath":"C:/out.mp4"}"#;
        let j: ExportJob = serde_json::from_str(json).unwrap();
        assert_eq!(j.clips[0].kind, ClipKind::Freeze);
        assert_eq!(j.clips[0].overlays[0].start, 1.5);
        assert_eq!((j.fps, j.canvas.w, j.output_path.as_str()), (30, 1080, "C:/out.mp4"));
        assert_eq!(j.duration(), 3.0);
    }

    #[test]
    fn clip_json_without_kind_or_speed_is_a_normal_speed_video() {
        let json = r#"{"source":"a","clip":{"width":1920,"height":1080,"fps":"60","codec":"h264","duration":5,"hasAudio":false},
          "preset":{"id":"p","name":"P","version":1,"background":{"type":"none"},"layers":[{"id":"g","src":[0,0,1,1],"dst":[0,0,1080,1920]}]},
          "trim":{"inS":0,"outS":5},"layerMasks":{},"overlays":[]}"#;
        let c: ClipJob = serde_json::from_str(json).unwrap();
        assert_eq!((c.kind, c.speed), (ClipKind::Video, 1.0));
    }

    #[test]
    fn durations_match_the_shared_golden_fixture() {
        let g: serde_json::Value = serde_json::from_str(include_str!("../../src/test/fixtures/timeline-golden.json")).unwrap();
        for case in g["layout"].as_array().unwrap() {
            let clips: Vec<ClipJob> = case["clips"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| {
                    let mut x = clip();
                    x.kind = if c["kind"] == "freeze" { ClipKind::Freeze } else { ClipKind::Video };
                    x.trim = Trim { in_s: c["inS"].as_f64().unwrap(), out_s: c["outS"].as_f64().unwrap() };
                    x.speed = c["speed"].as_f64().unwrap();
                    x
                })
                .collect();
            let durations: Vec<f64> = clips.iter().map(ClipJob::duration).collect();
            let want: Vec<f64> = case["durations"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            assert_eq!(durations, want, "{}", case["name"]);
            let j = ExportJob { clips, ..job() };
            assert_eq!(j.duration(), case["total"].as_f64().unwrap());
        }
    }

    #[test]
    fn a_valid_job_passes() {
        assert!(validate_job(&job()).is_ok());
    }

    #[test]
    fn rejects_bad_projects() {
        let mut j = job();
        j.clips.clear();
        assert!(validate_job(&j).unwrap_err().contains("1 to 200"));
        let mut j = job();
        j.clips = vec![clip(); MAX_CLIPS + 1];
        assert!(validate_job(&j).is_err());
        let mut j = job();
        j.fps = 24;
        assert!(validate_job(&j).unwrap_err().contains("fps"));
        for c in [Canvas { w: 1080, h: 1920 }, Canvas { w: 1920, h: 1080 }, Canvas { w: 2560, h: 1440 }] {
            let mut j = job();
            j.canvas = c;
            assert!(validate_job(&j).is_ok(), "{c:?}");
        }
        let mut j = job();
        j.canvas = Canvas { w: 1280, h: 720 };
        assert!(validate_job(&j).unwrap_err().contains("1080x1920, 1920x1080 or 2560x1440"));
    }

    #[test]
    fn rejects_bad_clips_with_their_position() {
        let bad = |f: fn(&mut ClipJob)| {
            let mut j = job();
            j.clips.push(clip());
            f(&mut j.clips[1]);
            validate_job(&j).unwrap_err()
        };
        assert!(bad(|c| c.trim.out_s = 31.0).starts_with("clip 2:"));
        assert!(bad(|c| c.trim.in_s = 12.0).contains("in/out"));
        assert!(bad(|c| c.trim.in_s = f64::NAN).contains("in/out"));
        assert!(bad(|c| c.speed = 5.0).contains("speed"));
        assert!(bad(|c| {
            c.kind = ClipKind::Freeze;
            c.trim = Trim { in_s: 1.0, out_s: 62.0 };
        })
        .contains("freeze"));
        assert!(bad(|c| {
            c.kind = ClipKind::Freeze;
            c.speed = 2.0;
        })
        .contains("freeze"));
    }

    #[test]
    fn a_freeze_needs_a_frame_after_its_in_point() {
        let freeze_at = |in_s: f64| {
            let mut j = job();
            j.clips[0].kind = ClipKind::Freeze;
            j.clips[0].trim = Trim { in_s, out_s: in_s + 1.0 };
            validate_job(&j)
        };
        assert!(freeze_at(29.98).is_ok());
        assert!(freeze_at(30.0).unwrap_err().contains("freeze"), "-ss at the very end yields no frame");
        assert!(freeze_at(29.995).unwrap_err().contains("freeze"));
    }
}
