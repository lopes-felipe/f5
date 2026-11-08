//! Held physical input, corroborated twice: the low-level hook saw the down (not injected, not
//! F5's own) and `GetAsyncKeyState` still reports it. Async key state alone has no owner or age:
//! a key-up lost to the secure desktop, a lock or a device disconnect, or another tool's
//! injected input would otherwise block a foreground takeover forever while nobody touches the
//! keyboard or mouse. A hold with no physical input of any kind for `STALE_AFTER_MS` stops
//! counting: real key holds repeat and real drags move.
use serde_json::{json, Value};
use std::collections::HashMap;

pub const STALE_AFTER_MS: u64 = 10_000;
pub const REPORT_LIMIT: usize = 8;

/// One hook event, reduced to what held-input tracking needs. Codes are virtual-key codes;
/// mouse buttons use `VK_LBUTTON`, `VK_RBUTTON`, `VK_MBUTTON`, `VK_XBUTTON1` and `VK_XBUTTON2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeldEvent {
    Down(u16),
    Up(u16),
    Activity,
}

#[derive(Default)]
pub struct HeldInputTracker {
    downs: HashMap<u16, u64>,
    last_physical_ms: Option<u64>,
}

impl HeldInputTracker {
    pub fn observe(&mut self, event: HeldEvent, now_ms: u64) {
        self.last_physical_ms = Some(now_ms);
        match event {
            HeldEvent::Down(code) => {
                self.downs.entry(code).or_insert(now_ms);
            }
            HeldEvent::Up(code) => {
                self.downs.remove(&code);
            }
            HeldEvent::Activity => {}
        }
    }
    /// The hooks were (re)installed: edges may have been missed while they were down.
    pub fn reset(&mut self) {
        self.downs.clear();
        self.last_physical_ms = None;
    }
    pub fn candidates(&self) -> Vec<u16> {
        self.downs.keys().copied().collect()
    }
    /// Holds the hook saw and the system still reports, oldest first. Entries the system
    /// reports released are dropped; stale holds are kept but not reported.
    pub fn held(&mut self, now_ms: u64, system_held: impl Fn(u16) -> bool) -> Vec<u16> {
        self.downs.retain(|code, _| system_held(*code));
        match self.last_physical_ms {
            Some(last) if now_ms.saturating_sub(last) <= STALE_AFTER_MS => {}
            _ => return Vec::new(),
        }
        let mut held: Vec<(u64, u16)> = self.downs.iter().map(|(code, at)| (*at, *code)).collect();
        held.sort_unstable();
        held.into_iter()
            .take(REPORT_LIMIT)
            .map(|(_, code)| code)
            .collect()
    }
}

/// Diagnostic only: virtual-key codes, never characters.
pub fn diagnostic(code: u16) -> Value {
    let kind = match code {
        0x01 | 0x02 | 0x04 | 0x05 | 0x06 => "button",
        0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5 => "modifier",
        _ => "key",
    };
    json!({"kind": kind, "code": code})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn down_then_up_is_not_held() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.observe(HeldEvent::Up(0x41), 10);
        assert!(tracker.held(20, |_| true).is_empty());
    }

    #[test]
    fn corroborated_recent_hold_is_held_oldest_first() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0xA0), 0);
        tracker.observe(HeldEvent::Down(0x01), 5);
        tracker.observe(HeldEvent::Down(0xA0), 9); // auto-repeat keeps the first down time
        assert_eq!(tracker.held(10, |_| true), vec![0xA0, 0x01]);
    }

    #[test]
    fn system_hold_the_hook_never_saw_is_not_held() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Activity, 0);
        assert!(tracker.held(1, |_| true).is_empty());
    }

    #[test]
    fn hooked_hold_the_system_reports_released_is_dropped() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.observe(HeldEvent::Down(0xA0), 0);
        assert_eq!(tracker.held(1, |code| code == 0xA0), vec![0xA0]);
        assert_eq!(tracker.held(2, |_| true), vec![0xA0]);
    }

    #[test]
    fn hold_without_recent_physical_input_stops_counting() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0xA2), 0);
        assert_eq!(tracker.held(STALE_AFTER_MS, |_| true), vec![0xA2]);
        assert!(tracker.held(STALE_AFTER_MS + 1, |_| true).is_empty());
        tracker.observe(HeldEvent::Activity, 20_000);
        assert_eq!(tracker.held(20_001, |_| true), vec![0xA2]);
    }

    #[test]
    fn reset_clears_entries_and_activity() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.reset();
        assert!(tracker.candidates().is_empty());
        assert!(tracker.held(1, |_| true).is_empty());
    }

    #[test]
    fn report_is_capped_and_diagnostics_carry_codes_only() {
        let mut tracker = HeldInputTracker::default();
        for code in 0x41..0x4D {
            tracker.observe(HeldEvent::Down(code), code as u64);
        }
        let held = tracker.held(100, |_| true);
        assert_eq!(held.len(), REPORT_LIMIT);
        assert_eq!(held[0], 0x41);
        assert_eq!(diagnostic(0x41), json!({"kind": "key", "code": 0x41}));
        assert_eq!(diagnostic(0xA0)["kind"], "modifier");
        assert_eq!(diagnostic(0x05)["kind"], "button");
    }
}
