use std::time::{Duration, Instant};

pub fn post_action_settle_ms(
    op: &str,
    screenshot: bool,
    app_targeted: bool,
    display_count: usize,
) -> u64 {
    if screenshot || matches!(op, "openApp" | "activateApp") || !app_targeted || display_count != 1
    {
        300
    } else {
        0
    }
}

pub fn poll_until(
    timeout: Duration,
    mut cancelled: impl FnMut() -> bool,
    mut predicate: impl FnMut() -> bool,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled() {
            return false;
        }
        if predicate() {
            return true;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        std::thread::sleep(remaining.min(Duration::from_millis(25)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_dependent_settle_table() {
        for op in ["type", "key", "elementAction", "openApp", "activateApp"] {
            for screenshot in [false, true] {
                for targeted in [false, true] {
                    for displays in [0, 1, 2] {
                        let inline = screenshot
                            || !targeted
                            || displays != 1
                            || matches!(op, "openApp" | "activateApp");
                        assert_eq!(
                            post_action_settle_ms(op, screenshot, targeted, displays),
                            if inline { 300 } else { 0 }
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn polling_stops_on_success_expiry_and_cancellation() {
        assert!(poll_until(Duration::ZERO, || false, || true));
        assert!(!poll_until(Duration::ZERO, || false, || false));
        assert!(!poll_until(
            Duration::from_secs(1),
            || true,
            || panic!("cancelled")
        ));
    }
}
