pub fn parse_progress_line(line: &str, total_us: f64) -> Option<f64> {
    // ffmpeg's out_time_ms is also microseconds (historical naming bug).
    let v = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms="))?;
    let us: f64 = v.trim().parse().ok()?;
    if total_us <= 0.0 {
        return None;
    }
    Some((us / total_us).clamp(0.0, 1.0))
}

pub fn eta(elapsed_s: f64, fraction: f64) -> Option<f64> {
    (fraction >= 0.02).then(|| elapsed_s / fraction * (1.0 - fraction))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_out_time() {
        assert_eq!(parse_progress_line("out_time_us=5000000", 10_000_000.0), Some(0.5));
        assert_eq!(parse_progress_line("out_time_ms=20000000", 10_000_000.0), Some(1.0));
        assert_eq!(parse_progress_line("out_time_us=N/A", 10_000_000.0), None);
        assert_eq!(parse_progress_line("frame=12", 10_000_000.0), None);
        assert_eq!(parse_progress_line("out_time_us=5", 0.0), None);
    }

    #[test]
    fn eta_waits_for_2_percent() {
        assert_eq!(eta(1.0, 0.01), None);
        assert_eq!(eta(10.0, 0.5), Some(10.0));
    }
}
