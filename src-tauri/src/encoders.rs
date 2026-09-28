use serde::Serialize;

use crate::job::Quality;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Encoder {
    Nvenc,
    Amf,
    Qsv,
    /// Apple VideoToolbox (macOS). Bitrate mode: constant-quality (-q:v) only exists on Apple Silicon.
    VideoToolbox,
    X264,
    OpenH264,
}

pub const GPU: [Encoder; 4] = [Encoder::Nvenc, Encoder::Amf, Encoder::Qsv, Encoder::VideoToolbox];
pub const CPU: [Encoder; 2] = [Encoder::X264, Encoder::OpenH264];

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

impl Encoder {
    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            Encoder::Nvenc => "h264_nvenc",
            Encoder::Amf => "h264_amf",
            Encoder::Qsv => "h264_qsv",
            Encoder::VideoToolbox => "h264_videotoolbox",
            Encoder::X264 => "libx264",
            Encoder::OpenH264 => "libopenh264",
        }
    }

    pub fn is_gpu(self) -> bool {
        GPU.contains(&self)
    }

    pub fn args(self, q: Quality) -> Vec<String> {
        let hi = q == Quality::High;
        match self {
            Encoder::Nvenc => s(&["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", if hi { "19" } else { "26" }, "-b:v", "0"]),
            Encoder::Amf => {
                let qp = if hi { "20" } else { "27" };
                s(&["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", qp, "-qp_p", qp])
            }
            Encoder::Qsv => s(&["-c:v", "h264_qsv", "-global_quality", if hi { "20" } else { "27" }]),
            // allow_sw keeps exports working on Macs whose hardware encoder is busy or missing.
            Encoder::VideoToolbox => s(&["-c:v", "h264_videotoolbox", "-b:v", if hi { "20M" } else { "8M" }, "-allow_sw", "1"]),
            Encoder::X264 => s(&["-c:v", "libx264", "-preset", "medium", "-crf", if hi { "18" } else { "24" }]),
            Encoder::OpenH264 => s(&["-c:v", "libopenh264", "-b:v", if hi { "12M" } else { "6M" }]),
        }
    }
}

pub trait Runner {
    fn succeeds(&self, args: &[String]) -> bool;
}

/// One-frame test encode; a GPU encoder listed by ffmpeg can still fail without the right hardware/driver.
pub fn probe_args(enc: Encoder) -> Vec<String> {
    s(&["-hide_banner", "-nostdin", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1", "-frames:v", "1", "-c:v", enc.ffmpeg_name(), "-f", "null", "-"])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EncoderSet {
    pub gpu: Option<Encoder>,
    pub cpu: Option<Encoder>,
}

impl EncoderSet {
    pub fn primary(&self) -> Option<Encoder> {
        self.gpu.or(self.cpu)
    }

    pub fn fallback_for(&self, used: Encoder) -> Option<Encoder> {
        if used.is_gpu() {
            self.cpu
        } else {
            None
        }
    }
}

pub fn detect(runner: &dyn Runner) -> EncoderSet {
    EncoderSet {
        gpu: GPU.into_iter().find(|e| runner.succeeds(&probe_args(*e))),
        cpu: CPU.into_iter().find(|e| runner.succeeds(&probe_args(*e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Only(&'static [&'static str]);
    impl Runner for Only {
        fn succeeds(&self, args: &[String]) -> bool {
            args.iter().any(|a| self.0.contains(&a.as_str()))
        }
    }

    #[test]
    fn detect_picks_first_working_gpu_and_cpu() {
        let set = detect(&Only(&["h264_amf", "h264_qsv", "libopenh264"]));
        assert_eq!(set, EncoderSet { gpu: Some(Encoder::Amf), cpu: Some(Encoder::OpenH264) });
        assert_eq!(set.primary(), Some(Encoder::Amf));
        assert_eq!(set.fallback_for(Encoder::Amf), Some(Encoder::OpenH264));
        assert_eq!(set.fallback_for(Encoder::OpenH264), None);
    }

    #[test]
    fn detect_with_nothing_available() {
        let set = detect(&Only(&[]));
        assert_eq!(set.primary(), None);
    }

    #[test]
    fn videotoolbox_is_a_gpu_encoder_with_bitrate_args() {
        assert!(Encoder::VideoToolbox.is_gpu());
        assert_eq!(Encoder::VideoToolbox.ffmpeg_name(), "h264_videotoolbox");
        let a = Encoder::VideoToolbox.args(Quality::High);
        assert!(a.windows(2).any(|w| w == ["-b:v", "20M"]) && a.windows(2).any(|w| w == ["-allow_sw", "1"]));
        let set = detect(&Only(&["h264_videotoolbox"]));
        assert_eq!(set, EncoderSet { gpu: Some(Encoder::VideoToolbox), cpu: None });
    }

    #[test]
    fn quality_changes_encoder_args() {
        assert!(Encoder::X264.args(Quality::High).contains(&"18".to_string()));
        assert!(Encoder::X264.args(Quality::Small).contains(&"24".to_string()));
    }
}
