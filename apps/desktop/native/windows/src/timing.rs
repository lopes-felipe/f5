use std::time::{Duration, Instant};

/// Epoch-millisecond deadlines must retain all 64 bits; invalid input expires closed.
pub fn request_deadline_expired(request: &serde_json::Value, now_ms: u128) -> bool {
    request["deadlineAtMs"].as_u64().unwrap_or(0) as u128 <= now_ms
}

/// Keep inline settling when subsequent target/display selection depends on its metadata.
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

/// Poll at most every 25 ms, stopping on cancellation or a monotonic timeout.
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
    fn epoch_deadlines_preserve_high_bits_and_fail_closed() {
        // Both positive and negative i32 truncations must retain their epoch value.
        for now in [1_790_000_000_000u64, 1_792_000_000_000] {
            assert!(!request_deadline_expired(
                &serde_json::json!({"deadlineAtMs": now + 300}),
                now as u128
            ));
            for deadline in [now - 1, now] {
                assert!(request_deadline_expired(
                    &serde_json::json!({"deadlineAtMs": deadline}),
                    now as u128
                ));
            }
        }
        for request in [
            serde_json::json!({}),
            serde_json::json!({"deadlineAtMs": -1}),
            serde_json::json!({"deadlineAtMs": 1.5}),
            serde_json::json!({"deadlineAtMs": "9999999999999"}),
            serde_json::json!({"deadlineAtMs": null}),
        ] {
            assert!(request_deadline_expired(&request, 1_790_000_000_000));
        }
    }
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
