use crate::ffmpeg::tool_command;
use crate::job::{AudioTrackInfo, ClipInfo};

const UNREADABLE: &str = "This file isn't a video SocialFrag can read.";

pub fn parse_probe(json: &str) -> Result<ClipInfo, String> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let streams = v["streams"].as_array().ok_or("no streams")?;
    let video = streams.iter().find(|s| s["codec_type"] == "video").ok_or("no video stream")?;
    let width = video["width"].as_u64().ok_or("no width")? as u32;
    let height = video["height"].as_u64().ok_or("no height")? as u32;
    // r_frame_rate is the nominal rate; avg_frame_rate drops on VFR captures with skipped frames (ShadowPlay).
    let fps = [&video["r_frame_rate"], &video["avg_frame_rate"]]
        .iter()
        .filter_map(|f| f.as_str())
        .find(|f| !f.starts_with("0/") && !f.is_empty())
        .unwrap_or("60")
        .to_string();
    let parse = |d: &serde_json::Value| d.as_str().and_then(|s| s.parse::<f64>().ok());
    let duration = parse(&v["format"]["duration"]).or_else(|| parse(&video["duration"])).ok_or("no duration")?;
    let audio_tracks: Vec<AudioTrackInfo> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .enumerate()
        .map(|(i, s)| {
            let tag = |k: &str| s["tags"][k].as_str().map(str::trim).filter(|l| !l.is_empty()).map(String::from);
            let label = tag("name").or_else(|| tag("title"));
            AudioTrackInfo {
                index: i as u32,
                named: label.is_some(),
                label: label.unwrap_or_else(|| format!("Track {}", i + 1)),
                channels: s["channels"].as_u64().unwrap_or(2) as u32,
            }
        })
        .collect();
    Ok(ClipInfo {
        width,
        height,
        fps,
        codec: video["codec_name"].as_str().unwrap_or("unknown").into(),
        codec_tag: video["codec_tag_string"].as_str().unwrap_or("").into(),
        duration,
        has_audio: !audio_tracks.is_empty(),
        audio_tracks,
    })
}

pub fn probe_clip_file(path: &str) -> Result<ClipInfo, String> {
    let out = tool_command("ffprobe")
        .args(["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path])
        .output()
        .map_err(|e| format!("Couldn't run ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(UNREADABLE.into());
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout)).map_err(|_| UNREADABLE.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hevc_clip_with_audio() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"hevc","width":2560,"height":1440,"r_frame_rate":"60/1","avg_frame_rate":"60000/1001"},
            {"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"12.500000"}}"#;
        let c = parse_probe(json).unwrap();
        assert_eq!((c.width, c.height, c.fps.as_str(), c.codec.as_str(), c.duration, c.has_audio), (2560, 1440, "60/1", "hevc", 12.5, true));
    }

    #[test]
    fn falls_back_to_r_frame_rate_and_stream_duration() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"144/1","avg_frame_rate":"0/0","duration":"3.0"}],"format":{}}"#;
        let c = parse_probe(json).unwrap();
        assert_eq!(c.fps, "144/1");
        assert_eq!(c.duration, 3.0);
        assert!(!c.has_audio);
    }

    #[test]
    fn rejects_audio_only_and_garbage() {
        assert!(parse_probe(r#"{"streams":[{"codec_type":"audio"}],"format":{"duration":"1"}}"#).is_err());
        assert!(parse_probe("not json").is_err());
    }

    #[test]
    fn vfr_clip_uses_nominal_rate_not_measured_average() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"60/1","avg_frame_rate":"13320/359"}],"format":{"duration":"10"}}"#;
        assert_eq!(parse_probe(json).unwrap().fps, "60/1");
    }

    #[test]
    fn falls_back_to_avg_when_r_frame_rate_missing() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"0/0","avg_frame_rate":"30000/1001"}],"format":{"duration":"10"}}"#;
        assert_eq!(parse_probe(json).unwrap().fps, "30000/1001");
    }

    #[test]
    fn reads_obs_track_labels_in_order() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"hevc","width":1920,"height":1080,"r_frame_rate":"120/1"},
            {"codec_type":"audio","channels":2,"tags":{"name":"Desktop Audio"}},
            {"codec_type":"audio","channels":1,"tags":{"title":" Game "}},
            {"codec_type":"audio","channels":2,"tags":{"name":""}}],"format":{"duration":"10"}}"#;
        let c = parse_probe(json).unwrap();
        let t: Vec<_> = c.audio_tracks.iter().map(|a| (a.index, a.label.as_str(), a.named, a.channels)).collect();
        assert_eq!(t, vec![(0, "Desktop Audio", true, 2), (1, "Game", true, 1), (2, "Track 3", false, 2)]);
        assert!(c.has_audio);
    }

    #[test]
    fn reads_codec_tag() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"hevc","codec_tag_string":"hev1","width":1920,"height":1080,"r_frame_rate":"120/1"}],"format":{"duration":"1"}}"#;
        assert_eq!(parse_probe(json).unwrap().codec_tag, "hev1");
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"60/1"}],"format":{"duration":"1"}}"#;
        assert_eq!(parse_probe(json).unwrap().codec_tag, "");
    }

    #[test]
    fn no_audio_streams_gives_empty_track_list() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"r_frame_rate":"60/1"}],"format":{"duration":"1"}}"#;
        assert!(parse_probe(json).unwrap().audio_tracks.is_empty());
    }
}
