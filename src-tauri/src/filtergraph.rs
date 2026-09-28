use std::collections::HashMap;
use std::path::Path;

use crate::audio_mix::{enabled_tracks, GAIN_RATE};
use crate::encoders::Encoder;
use crate::export::ClipAssets;
use crate::job::{Canvas, ClipJob, ClipKind, ExportJob};
use crate::preset::{layout_layer, Background, Layer, LayerLayout};

pub fn secs(v: f64) -> String {
    format!("{v:.3}")
}

/// Seconds of source audio opened before the in point so negative offsets have audio to use.
const AUDIO_LEAD: f64 = 2.0;
const LIMITER: &str = "attack=1:release=50:level=0:latency=1";
/// Every clip's audio leaves in this format so concat joins them without renegotiating.
const AFMT: &str = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

fn is_one(speed: f64) -> bool {
    (speed - 1.0).abs() < 1e-9
}

/// Source seconds read for the clip's video: the trim, or a moment's worth for a freeze frame.
fn video_span(c: &ClipJob) -> f64 {
    match c.kind {
        ClipKind::Video => c.trim.out_s - c.trim.in_s,
        ClipKind::Freeze => 1.0,
    }
}

fn audio_seek(c: &ClipJob) -> f64 {
    (c.trim.in_s - AUDIO_LEAD).max(0.0)
}

/// One clip's picture on the canvas, labelled [v{n}]: speed and frame rate first (so 144/240 fps
/// sources aren't composed at full rate), then background, layers and overlays, then normalised
/// (length, pixel format, SAR, timebase) so concat can join clips from different sources.
pub fn build_clip_video(c: &ClipJob, n: usize, v_in: usize, masks: &HashMap<&str, usize>, overlays: &[(usize, f64)], captions: Option<usize>, fps: &str, canvas: &Canvas) -> String {
    let p = &c.preset;
    let (sw, sh) = (c.clip.width as i64, c.clip.height as i64);
    let (w, h) = (canvas.w, canvas.h);
    let dur = secs(c.duration());
    let visible: Vec<&Layer> = p.layers.iter().filter(|l| !l.hidden).collect();
    let layouts: Vec<LayerLayout> = visible.iter().map(|l| layout_layer(l.src, l.dst, l.fit, sw, sh)).collect();
    let mut parts: Vec<String> = Vec::new();

    let head = match c.kind {
        ClipKind::Video if is_one(c.speed) => format!("[{v_in}:v]fps={fps}"),
        ClipKind::Video => format!("[{v_in}:v]setpts=(PTS-STARTPTS)/{},fps={fps}", c.speed),
        ClipKind::Freeze => format!("[{v_in}:v]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={dur},fps={fps}"),
    };
    let mut split = format!("{head},split={}[n{n}bg]", visible.len() + 1);
    for i in 0..visible.len() {
        split.push_str(&format!("[n{n}s{i}]"));
    }
    parts.push(split);

    parts.push(match &p.background {
        Background::Blur { amount } => format!(
            "[n{n}bg]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},scale={}:{},gblur=sigma={},scale={w}:{h}[n{n}b]",
            w / 4,
            h / 4,
            secs(amount / 4.0)
        ),
        Background::Color { color } => format!("[n{n}bg]scale={w}:{h},drawbox=x=0:y=0:w=iw:h=ih:color={color}:t=fill[n{n}b]"),
        Background::None => format!("[n{n}bg]scale={w}:{h},drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[n{n}b]"),
    });

    for (i, (l, lay)) in visible.iter().zip(&layouts).enumerate() {
        let [cx, cy, cw, ch] = lay.crop;
        let [_, _, dw, dh] = lay.draw;
        let base = format!("[n{n}s{i}]crop={cw}:{ch}:{cx}:{cy}:exact=1,scale={dw}:{dh}");
        match masks.get(l.id.as_str()) {
            Some(m) => {
                parts.push(format!("{base},format=rgba[n{n}l{i}p]"));
                parts.push(format!("[{m}:v]format=gray,scale={dw}:{dh}[n{n}m{i}]"));
                parts.push(format!("[n{n}l{i}p][n{n}m{i}]alphamerge[n{n}l{i}]"));
            }
            None => parts.push(format!("{base}[n{n}l{i}]")),
        }
    }

    let mut last = format!("n{n}b");
    for (i, lay) in layouts.iter().enumerate() {
        parts.push(format!("[{last}][n{n}l{i}]overlay=x={}:y={}[n{n}c{i}]", lay.draw[0], lay.draw[1]));
        last = format!("n{n}c{i}");
    }
    for (k, (input, rel)) in overlays.iter().enumerate() {
        let enable = if *rel > 0.0005 { format!(":enable='gte(t,{})'", secs(*rel)) } else { String::new() };
        parts.push(format!("[{last}][{input}:v]overlay=x=0:y=0{enable}[n{n}o{k}]"));
        last = format!("n{n}o{k}");
    }
    if let Some(cap) = captions {
        // One image-sequence input for every caption; eof_action=pass so nothing lingers after the last frame.
        parts.push(format!("[{cap}:v]setpts=PTS-STARTPTS,format=rgba[n{n}cap]"));
        parts.push(format!("[{last}][n{n}cap]overlay=x=0:y=0:eof_action=pass[n{n}ov]"));
        last = format!("n{n}ov");
    }
    parts.push(format!("[{last}]trim=duration={dur},format=yuv420p,setsar=1,settb=AVTB[v{n}]"));
    parts.join(";")
}

/// One clip's tracks mixed to stereo, labelled [a{n}]: per-track offset/trim, × gain curve, optional
/// ceiling, amix, then resampled for speed (pitch follows speed, as in the preview). No master
/// limiter here; that runs once after concat.
pub fn build_clip_audio(c: &ClipJob, n: usize, a_in: usize, gain_inputs: &[(u32, usize)]) -> Option<String> {
    let dur = c.trim.out_s - c.trim.in_s;
    let lead = c.trim.in_s - audio_seek(c);
    let fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
    let mut parts = Vec::new();
    let mut outs = Vec::new();
    for (k, t) in enabled_tracks(c).into_iter().enumerate() {
        let Some(&(_, g)) = gain_inputs.iter().find(|(i, _)| *i == t.index) else { continue };
        let start = lead - t.offset_s;
        parts.push(if start >= 0.0 {
            format!("[{a_in}:a:{}]atrim=start={},asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration={}[n{n}t{k}]", t.index, secs(start), secs(dur))
        } else {
            format!("[{a_in}:a:{}]{fmt},adelay=delays={}:all=1,apad,atrim=duration={}[n{n}t{k}]", t.index, (-start * 1000.0).round() as i64, secs(dur))
        });
        parts.push(format!("[{g}:a]aresample=48000,aformat=channel_layouts=stereo[n{n}g{k}]"));
        let ceiling = t.ceiling_db.map(|db| format!(",alimiter=limit={:.3}:{LIMITER}", 10f64.powf(db / 20.0))).unwrap_or_default();
        parts.push(format!("[n{n}t{k}][n{n}g{k}]amultiply{ceiling}[n{n}c{k}]"));
        outs.push(format!("[n{n}c{k}]"));
    }
    if outs.is_empty() {
        return None;
    }
    let speed = if is_one(c.speed) { String::new() } else { format!("asetrate={},aresample=48000,", (48000.0 * c.speed).round() as i64) };
    let tail = format!("{speed}{AFMT}[a{n}]");
    parts.push(if outs.len() == 1 {
        format!("{}{tail}", outs[0])
    } else {
        format!("{}amix=inputs={}:normalize=0:duration=first,{tail}", outs.join(""), outs.len())
    });
    Some(parts.join(";"))
}

pub fn build_args(job: &ExportJob, assets: &[ClipAssets], enc: Encoder, out: &Path) -> Vec<String> {
    let fps = job.fps.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1"].map(String::from).to_vec();
    let mut next = 0usize;
    let mut graph: Vec<String> = Vec::new();
    let mut audio: Vec<Option<String>> = Vec::new();

    for (n, (c, a)) in job.clips.iter().zip(assets).enumerate() {
        let dur = c.duration();
        let v_in = next;
        next += 1;
        args.extend(["-ss".into(), secs(c.trim.in_s), "-t".into(), secs(video_span(c)), "-i".into(), c.source.clone()]);

        let mut mask_inputs: HashMap<&str, usize> = HashMap::new();
        for (id, p) in &a.masks {
            args.extend(["-loop".into(), "1".into(), "-framerate".into(), fps.clone(), "-t".into(), secs(dur), "-i".into(), p.to_string_lossy().into_owned()]);
            mask_inputs.insert(id.as_str(), next);
            next += 1;
        }
        let mut overlay_inputs = Vec::new();
        for (p, start) in &a.overlays {
            if *start >= dur {
                continue;
            }
            // Single frame: overlay's default eof_action=repeat holds it, so the PNG is decoded once, not per frame.
            args.extend(["-i".into(), p.to_string_lossy().into_owned()]);
            overlay_inputs.push((next, *start));
            next += 1;
        }

        let mut caption_input = None;
        if let Some(p) = &a.captions {
            args.extend(["-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), p.to_string_lossy().into_owned()]);
            caption_input = Some(next);
            next += 1;
        }

        let mut clip_audio = None;
        if !a.gains.is_empty() {
            let a_in = next;
            next += 1;
            args.extend(["-ss".into(), secs(audio_seek(c)), "-t".into(), secs(c.trim.out_s - c.trim.in_s + 2.0 * AUDIO_LEAD), "-i".into(), c.source.clone()]);
            let mut gain_inputs = Vec::new();
            for (idx, p) in &a.gains {
                args.extend(["-f", "f32le", "-ar", &format!("{GAIN_RATE}"), "-ac", "1", "-i"].map(String::from));
                args.push(p.to_string_lossy().into_owned());
                gain_inputs.push((*idx, next));
                next += 1;
            }
            clip_audio = build_clip_audio(c, n, a_in, &gain_inputs);
        }
        graph.push(build_clip_video(c, n, v_in, &mask_inputs, &overlay_inputs, caption_input, &fps, &job.canvas));
        audio.push(clip_audio);
    }

    let has_audio = audio.iter().any(Option::is_some);
    let mut cat = String::new();
    for (n, a) in audio.into_iter().enumerate() {
        cat.push_str(&format!("[v{n}]"));
        if has_audio {
            graph.push(a.unwrap_or_else(|| format!("anullsrc=r=48000:cl=stereo,atrim=duration={},{AFMT}[a{n}]", secs(job.clips[n].duration()))));
            cat.push_str(&format!("[a{n}]"));
        }
    }
    let count = job.clips.len();
    if has_audio {
        graph.push(format!("{cat}concat=n={count}:v=1:a=1[vout][acat]"));
        graph.push(format!("[acat]alimiter=limit=0.891:{LIMITER}[aout]"));
    } else {
        graph.push(format!("{cat}concat=n={count}:v=1:a=0[vout]"));
    }

    args.push("-filter_complex".into());
    args.push(graph.join(";"));
    args.extend(["-map".into(), "[vout]".into()]);
    if has_audio {
        args.extend(["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"].map(String::from));
    }
    args.extend(enc.args(job.quality));
    if !has_audio {
        args.push("-an".into());
    }
    args.extend(["-movflags", "+faststart"].map(String::from));
    args.push(out.to_string_lossy().into_owned());
    args
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::export::ClipAssets;
    use crate::job::fixtures::{clip, job};
    use crate::job::{ClipJob, ClipKind, Trim};

    const WARDOGS_FILTER: &str = "[0:v]fps=60,split=3[n0bg][n0s0][n0s1];\
[n0bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,gblur=sigma=7.500,scale=1080:1920[n0b];\
[n0s0]crop=845:845:538:118:exact=1,scale=1080:1080[n0l0];\
[n0s1]crop=442:162:1440:22:exact=1,scale=819:300,format=rgba[n0l1p];[1:v]format=gray,scale=819:300[n0m1];[n0l1p][n0m1]alphamerge[n0l1];\
[n0b][n0l0]overlay=x=0:y=420[n0c0];[n0c0][n0l1]overlay=x=132:y=80[n0c1];\
[n0c1][2:v]overlay=x=0:y=0[n0o0];[n0o0][3:v]overlay=x=0:y=0:enable='gte(t,2.000)'[n0o1];\
[n0o1]trim=duration=10.000,format=yuv420p,setsar=1,settb=AVTB[v0];\
[v0]concat=n=1:v=1:a=0[vout]";

    fn wardogs_args() -> Vec<String> {
        let assets = ClipAssets {
            masks: vec![("killfeed".into(), PathBuf::from("/w/c0-mask-1.png"))],
            overlays: vec![(PathBuf::from("/w/c0-overlay-0.png"), 0.0), (PathBuf::from("/w/c0-overlay-1.png"), 2.0), (PathBuf::from("/w/c0-overlay-2.png"), 10.0)],
            gains: vec![],
            captions: None,
        };
        build_args(&job(), &[assets], Encoder::Nvenc, Path::new("C:/clips/in_vertical.mp4"))
    }

    fn filter_of(args: &[String]) -> String {
        args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1].clone()
    }

    #[test]
    fn golden_wardogs_args() {
        let mut expected: Vec<&str> = vec!["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1", "-ss", "1.000", "-t", "10.000", "-i", "C:/clips/in.mp4"];
        expected.extend(["-loop", "1", "-framerate", "60", "-t", "10.000", "-i", "/w/c0-mask-1.png"]);
        // overlays are single-frame inputs: overlay's eof_action=repeat holds them, no per-frame PNG decode
        expected.extend(["-i", "/w/c0-overlay-0.png", "-i", "/w/c0-overlay-1.png"]);
        expected.extend(["-filter_complex", WARDOGS_FILTER, "-map", "[vout]"]);
        expected.extend(["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "19", "-b:v", "0"]);
        expected.extend(["-an", "-movflags", "+faststart", "C:/clips/in_vertical.mp4"]);
        assert_eq!(wardogs_args(), expected);
    }

    #[test]
    fn an_overlay_starting_at_or_after_the_clip_end_is_dropped() {
        assert!(!wardogs_args().iter().any(|a| a.contains("overlay-2")));
    }

    fn four_track_clip() -> ClipJob {
        let mut c = clip(); // trim 1..11, dur 10
        c.clip.audio_tracks = ["Desktop", "Game", "Discord", "Mic"]
            .iter()
            .enumerate()
            .map(|(i, l)| crate::job::AudioTrackInfo { index: i as u32, label: (*l).into(), named: true, channels: if i == 3 { 1 } else { 2 } })
            .collect();
        c.audio = serde_json::from_str(r#"{"tracks":[
            {"index":0,"enabled":false,"ceilingDb":null,"offsetS":0},
            {"index":1,"enabled":true,"ceilingDb":-3,"offsetS":0},
            {"index":2,"enabled":true,"ceilingDb":null,"offsetS":0.25},
            {"index":3,"enabled":true,"ceilingDb":null,"offsetS":-0.5}]}"#).unwrap();
        c
    }

    fn gains_for(n: usize, tracks: &[u32]) -> ClipAssets {
        ClipAssets { gains: tracks.iter().map(|t| (*t, PathBuf::from(format!("/w/c{n}-gain-{t}.f32")))).collect(), ..Default::default() }
    }

    #[test]
    fn golden_four_track_audio_filter() {
        // audio input 1; gain inputs 2,3,4 for tracks 1,2,3. in=1 -> audio input starts at 0, lead=1.
        let f = build_clip_audio(&four_track_clip(), 0, 1, &[(1, 2), (2, 3), (3, 4)]).unwrap();
        let fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
        let lim = "attack=1:release=50:level=0:latency=1";
        let expected = [
            format!("[1:a:1]atrim=start=1.000,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[n0t0]"),
            format!("[2:a]aresample=48000,aformat=channel_layouts=stereo[n0g0]"),
            format!("[n0t0][n0g0]amultiply,alimiter=limit=0.708:{lim}[n0c0]"),
            format!("[1:a:2]atrim=start=0.750,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[n0t1]"),
            format!("[3:a]aresample=48000,aformat=channel_layouts=stereo[n0g1]"),
            format!("[n0t1][n0g1]amultiply[n0c1]"),
            format!("[1:a:3]atrim=start=1.500,asetpts=PTS-STARTPTS,{fmt},apad,atrim=duration=10.000[n0t2]"),
            format!("[4:a]aresample=48000,aformat=channel_layouts=stereo[n0g2]"),
            format!("[n0t2][n0g2]amultiply[n0c2]"),
            "[n0c0][n0c1][n0c2]amix=inputs=3:normalize=0:duration=first,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]".to_string(),
        ]
        .join(";");
        assert_eq!(f, expected);
    }

    #[test]
    fn positive_offset_past_the_lead_pads_with_silence() {
        let mut c = four_track_clip();
        c.trim = Trim { in_s: 0.2, out_s: 5.2 }; // lead = 0.2
        c.audio.tracks.retain(|t| t.index == 2); // offset +0.25 => start -0.05
        let f = build_clip_audio(&c, 0, 1, &[(2, 2)]).unwrap();
        assert!(f.starts_with("[1:a:2]aformat=sample_rates=48000:channel_layouts=stereo,adelay=delays=50:all=1,apad,atrim=duration=5.000[n0t0]"), "{f}");
        assert!(f.ends_with("[n0c0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]"), "{f}");
    }

    #[test]
    fn audio_args_open_the_source_again_and_map_one_track() {
        let mut j = job();
        j.clips = vec![four_track_clip()];
        let a = build_args(&j, &[gains_for(0, &[1, 2, 3])], Encoder::X264, Path::new("out.mp4"));
        let s = a.join(" ");
        assert!(s.contains("-ss 0.000 -t 14.000 -i C:/clips/in.mp4"), "{s}");
        assert!(s.contains("-f f32le -ar 200 -ac 1 -i /w/c0-gain-1.f32"));
        assert!(s.contains("-map [aout] -c:a aac -b:a 192k"));
        assert!(!s.contains("-an"));
        let f = filter_of(&a);
        assert!(f.ends_with("[v0][a0]concat=n=1:v=1:a=1[vout][acat];[acat]alimiter=limit=0.891:attack=1:release=50:level=0:latency=1[aout]"), "{f}");
    }

    #[test]
    fn no_enabled_tracks_means_no_audio() {
        let mut j = job();
        let mut c = four_track_clip();
        c.audio.tracks.iter_mut().for_each(|t| t.enabled = false);
        j.clips = vec![c];
        let a = build_args(&j, &[ClipAssets::default()], Encoder::X264, Path::new("out.mp4"));
        assert!(a.contains(&"-an".to_string()));
        assert!(!a.iter().any(|x| x.contains("aout")));
        assert_eq!(a.iter().filter(|x| *x == "-i").count(), 1);
    }

    #[test]
    fn two_clips_with_speed_concat_video_and_audio() {
        let a = four_track_clip();
        let mut b = four_track_clip();
        b.trim = Trim { in_s: 20.0, out_s: 24.0 };
        b.speed = 2.0;
        let mut j = job();
        j.clips = vec![a, b];
        // inputs: clip 0 video 0, audio 1, gain 2; clip 1 video 3, audio 4, gain 5
        let args = build_args(&j, &[gains_for(0, &[1]), gains_for(1, &[1])], Encoder::X264, Path::new("out.mp4"));
        let s = args.join(" ");
        assert!(s.contains("-ss 20.000 -t 4.000 -i C:/clips/in.mp4"), "{s}");
        assert!(s.contains("-ss 18.000 -t 8.000 -i C:/clips/in.mp4"), "{s}");
        let f = filter_of(&args);
        assert!(f.contains("[3:v]setpts=(PTS-STARTPTS)/2,fps=60,split=3[n1bg][n1s0][n1s1]"), "{f}");
        assert!(f.contains("[n1c1]trim=duration=2.000,format=yuv420p,setsar=1,settb=AVTB[v1]"), "{f}");
        assert!(f.contains("[n1c0]asetrate=96000,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1]"), "{f}");
        assert!(f.contains("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][acat]"), "{f}");
    }

    #[test]
    fn freeze_and_silent_clips_get_generated_silence_when_others_have_audio() {
        let a = four_track_clip();
        let mut frz = four_track_clip();
        frz.kind = ClipKind::Freeze;
        frz.trim = Trim { in_s: 5.0, out_s: 8.0 };
        let mut silent = clip();
        silent.clip.has_audio = false;
        let mut j = job();
        j.clips = vec![a, frz, silent];
        let args = build_args(&j, &[gains_for(0, &[1]), ClipAssets::default(), ClipAssets::default()], Encoder::X264, Path::new("out.mp4"));
        let s = args.join(" ");
        assert!(s.contains("-ss 5.000 -t 1.000 -i C:/clips/in.mp4"), "{s}");
        let f = filter_of(&args);
        assert!(f.contains("[3:v]trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=3.000,fps=60,split=3[n1bg]"), "{f}");
        assert!(f.contains("anullsrc=r=48000:cl=stereo,atrim=duration=3.000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1]"), "{f}");
        assert!(f.contains("anullsrc=r=48000:cl=stereo,atrim=duration=10.000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a2]"), "{f}");
        assert!(f.contains("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vout][acat]"), "{f}");
        assert_eq!(args.iter().filter(|x| *x == "[aout]").count(), 1, "exactly one audio stream is mapped");
    }

    #[test]
    fn clips_of_different_sizes_crop_against_their_own_source() {
        let a = clip();
        let mut b = clip();
        b.clip.width = 2560;
        b.clip.height = 1440;
        b.clip.fps = "120".into();
        let mut j = job();
        j.clips = vec![a, b];
        let f = filter_of(&build_args(&j, &[ClipAssets::default(), ClipAssets::default()], Encoder::X264, Path::new("out.mp4")));
        assert!(f.contains("[n0s0]crop=845:845:538:118:exact=1,scale=1080:1080[n0l0]"), "{f}");
        assert!(f.contains("[n1s0]crop=1126:1126:717:157:exact=1,scale=1080:1080[n1l0]"), "{f}");
        // both leave at the project rate, size and timebase
        assert!(f.contains("[1:v]fps=60,") && f.contains("settb=AVTB[v1]"), "{f}");
    }

    #[test]
    fn source_path_with_spaces_and_quotes_is_one_argument() {
        let mut j = job();
        j.clips[0].source = r"C:\Users\José\Videos\Bob's clip (1).mp4".into();
        let args = build_args(&j, &[ClipAssets::default()], Encoder::X264, Path::new("out.mp4"));
        assert!(args.contains(&j.clips[0].source));
        assert!(!filter_of(&args).contains("José"));
    }

    #[test]
    fn hidden_layer_is_omitted_from_split_and_overlay_chain() {
        let mut c = clip();
        c.preset.layers[1].hidden = true; // killfeed
        let f = build_clip_video(&c, 0, 0, &HashMap::new(), &[], None, "60", &Canvas { w: 1080, h: 1920 });
        let expected = "[0:v]fps=60,split=2[n0bg][n0s0];\
[n0bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,scale=270:480,gblur=sigma=7.500,scale=1080:1920[n0b];\
[n0s0]crop=845:845:538:118:exact=1,scale=1080:1080[n0l0];\
[n0b][n0l0]overlay=x=0:y=420[n0c0];\
[n0c0]trim=duration=10.000,format=yuv420p,setsar=1,settb=AVTB[v0]";
        assert_eq!(f, expected);
    }

    #[test]
    fn color_and_none_backgrounds() {
        let canvas = Canvas { w: 1080, h: 1920 };
        let mut c = clip();
        c.preset.background = Background::Color { color: "#112233".into() };
        assert!(build_clip_video(&c, 0, 0, &HashMap::new(), &[], None, "60", &canvas).contains("[n0bg]scale=1080:1920,drawbox=x=0:y=0:w=iw:h=ih:color=#112233:t=fill[n0b]"));
        c.preset.background = Background::None;
        assert!(build_clip_video(&c, 0, 0, &HashMap::new(), &[], None, "60", &canvas).contains("color=black:t=fill[n0b]"));
    }

    #[test]
    fn landscape_full_frame_letterboxes_a_4x3_source() {
        let mut c = clip();
        c.clip.width = 1440;
        c.clip.height = 1080;
        c.preset.background = Background::None;
        c.preset.layers.truncate(1);
        c.preset.layers[0].src = [0.0, 0.0, 1.0, 1.0];
        c.preset.layers[0].dst = [0.0, 0.0, 1920.0, 1080.0];
        c.preset.layers[0].fit = crate::preset::Fit::Contain;
        let f = build_clip_video(&c, 0, 0, &HashMap::new(), &[], None, "60", &Canvas { w: 1920, h: 1080 });
        assert!(f.contains("[n0bg]scale=1920:1080,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[n0b]"), "{f}");
        assert!(f.contains("scale=1440:1080[n0l0]"), "{f}");
        assert!(f.contains("overlay=x=240:y=0"), "{f}");
    }

    #[test]
    fn captions_are_one_concat_input_and_one_overlay_even_with_300_lines() {
        let a = ClipAssets { captions: Some(PathBuf::from("/w/c0-captions.ffconcat")), ..Default::default() };
        let args = build_args(&job(), &[a], Encoder::Nvenc, Path::new("/o.mp4"));
        let s = args.join(" ");
        assert_eq!(s.matches("-f concat -safe 0 -i /w/c0-captions.ffconcat").count(), 1, "{s}");
        let f = filter_of(&args);
        assert_eq!(f.matches("overlay=x=0:y=0:eof_action=pass").count(), 1, "{f}");
        assert!(f.contains("[1:v]setpts=PTS-STARTPTS,format=rgba[n0cap]"), "{f}");
    }

}
