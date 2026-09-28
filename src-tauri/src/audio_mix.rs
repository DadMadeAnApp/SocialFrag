use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::job::{ClipJob, ClipKind, Trim};
use crate::preset::in_range;

/// Samples per second of the gain curves sent by the frontend (TS SAMPLE_RATE).
pub const GAIN_RATE: f64 = 200.0;

/// Only what the export needs: gain, mutes, fades and ducking are already baked into the curve.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMix {
    pub index: u32,
    pub enabled: bool,
    pub ceiling_db: Option<f64>,
    pub offset_s: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AudioMix {
    #[serde(default)]
    pub tracks: Vec<TrackMix>,
}

pub fn curve_samples(trim: &Trim) -> usize {
    ((trim.out_s - trim.in_s) * GAIN_RATE).round().max(0.0) as usize
}

/// Tracks that reach the export: enabled, present in the source, and not on a freeze frame (silent by design).
pub fn enabled_tracks(c: &ClipJob) -> Vec<&TrackMix> {
    if !c.clip.has_audio || c.kind == ClipKind::Freeze {
        return vec![];
    }
    c.audio.tracks.iter().filter(|t| t.enabled && c.clip.audio_tracks.iter().any(|a| a.index == t.index)).collect()
}

pub fn validate_mix(job: &ClipJob) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for t in &job.audio.tracks {
        if !seen.insert(t.index) {
            return Err(format!("duplicate audio track {}", t.index));
        }
        if !job.clip.audio_tracks.iter().any(|a| a.index == t.index) {
            return Err(format!("audio track {} is not in this clip", t.index));
        }
        if let Some(c) = t.ceiling_db {
            if !in_range(c, -24.0, 0.0) {
                return Err(format!("audio track {}: ceiling must be -24 to 0 dB", t.index));
            }
        }
        if !in_range(t.offset_s, -2.0, 2.0) {
            return Err(format!("audio track {}: offset must be -2 to 2 s", t.index));
        }
    }
    let want = curve_samples(&job.trim) as i64;
    for t in enabled_tracks(job) {
        let b64 = job.gain_curves.get(&t.index).ok_or_else(|| format!("audio track {}: missing gain curve", t.index))?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("audio track {}: bad gain curve ({e})", t.index))?;
        let got = (bytes.len() / 4) as i64;
        if bytes.len() % 4 != 0 || (got - want).abs() > 1 {
            return Err(format!("audio track {}: gain curve has {got} samples, expected {want}", t.index));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{fixtures::clip as job, AudioTrackInfo, ClipJob, ClipKind};
    use base64::Engine;

    pub fn ones(n: usize) -> String {
        base64::engine::general_purpose::STANDARD.encode(vec![1.0f32; n].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>())
    }

    fn with_tracks() -> ClipJob {
        let mut j = job(); // trim 1..11 => 2000 samples
        j.clip.audio_tracks = (0..2).map(|i| AudioTrackInfo { index: i, label: format!("T{i}"), named: true, channels: 2 }).collect();
        j.audio = serde_json::from_str(r#"{"tracks":[{"index":0,"enabled":true,"ceilingDb":-3,"offsetS":0,"gain":1,"mutes":[]},{"index":1,"enabled":false,"ceilingDb":null,"offsetS":0}],"duck":null}"#).unwrap();
        j.gain_curves.insert(0, ones(2000));
        j
    }

    #[test]
    fn valid_mix_passes_and_ignores_ts_only_fields() {
        let j = with_tracks();
        assert!(validate_mix(&j).is_ok());
        assert_eq!(enabled_tracks(&j).iter().map(|t| t.index).collect::<Vec<_>>(), [0]);
        assert_eq!(curve_samples(&j.trim), 2000);
    }

    #[test]
    fn rejects_bad_mixes() {
        let mut j = with_tracks();
        j.gain_curves.insert(0, ones(1990));
        assert!(validate_mix(&j).unwrap_err().contains("curve"));
        let mut j = with_tracks();
        j.gain_curves.clear();
        assert!(validate_mix(&j).unwrap_err().contains("curve"));
        let mut j = with_tracks();
        j.audio.tracks[0].index = 7;
        assert!(validate_mix(&j).unwrap_err().contains("track"));
        let mut j = with_tracks();
        j.audio.tracks[1].index = 0;
        assert!(validate_mix(&j).unwrap_err().contains("duplicate"));
        let mut j = with_tracks();
        j.audio.tracks[0].ceiling_db = Some(-30.0);
        assert!(validate_mix(&j).unwrap_err().contains("ceiling"));
        let mut j = with_tracks();
        j.audio.tracks[0].offset_s = 3.0;
        assert!(validate_mix(&j).unwrap_err().contains("offset"));
        let mut j = with_tracks();
        j.gain_curves.insert(0, "%%%".into());
        assert!(validate_mix(&j).is_err());
    }

    #[test]
    fn job_json_without_audio_still_parses() {
        let j: ClipJob = serde_json::from_str(r#"{"source":"a","clip":{"width":1920,"height":1080,"fps":"60","codec":"h264","duration":5,"hasAudio":false},
          "preset":{"id":"p","name":"P","version":1,"background":{"type":"none"},"layers":[{"id":"g","src":[0,0,1,1],"dst":[0,0,1080,1920]}]},
          "trim":{"inS":0,"outS":5},"layerMasks":{},"overlays":[]}"#).unwrap();
        assert!(j.audio.tracks.is_empty() && j.gain_curves.is_empty());
        let j: ClipJob = serde_json::from_str(r#"{"source":"a","clip":{"width":1920,"height":1080,"fps":"60","codec":"h264","duration":5,"hasAudio":true,"audioTracks":[{"index":0,"label":"G","named":true,"channels":2}]},
          "preset":{"id":"p","name":"P","version":1,"background":{"type":"none"},"layers":[{"id":"g","src":[0,0,1,1],"dst":[0,0,1080,1920]}]},
          "trim":{"inS":0,"outS":5},"layerMasks":{},"overlays":[],
          "audio":{"tracks":[{"index":0,"enabled":true,"ceilingDb":null,"offsetS":0}],"duck":null},"gainCurves":{"0":"AACAPw=="}}"#).unwrap();
        assert_eq!(j.gain_curves.len(), 1);
    }

    #[test]
    fn freeze_frames_have_no_audio() {
        let mut j = with_tracks();
        j.kind = ClipKind::Freeze;
        assert!(enabled_tracks(&j).is_empty());
        j.gain_curves.clear();
        assert!(validate_mix(&j).is_ok());
    }
}
