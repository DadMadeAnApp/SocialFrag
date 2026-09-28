use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::encoders::Runner;

/// Bundled sidecar next to the exe (release), SOCIALFRAG_FFMPEG_DIR (dev override), else PATH (e.g. Homebrew on the Mac).
pub fn tool_path(name: &str) -> PathBuf {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    if let Ok(dir) = std::env::var("SOCIALFRAG_FFMPEG_DIR") {
        let p = PathBuf::from(dir).join(&file);
        if p.exists() {
            return p;
        }
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        let p = dir.join(&file);
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(file)
}

pub fn tool_command(name: &str) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut c = Command::new(tool_path(name));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

pub struct RealRunner;

impl Runner for RealRunner {
    fn succeeds(&self, args: &[String]) -> bool {
        tool_command("ffmpeg")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}
