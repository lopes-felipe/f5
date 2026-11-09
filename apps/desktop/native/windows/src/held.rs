//! Held physical input, corroborated twice: the low-level hook saw the down (not injected, not
//! F5's own) and `GetAsyncKeyState` still reports it. Async key state alone has no owner or age:
//! a key-up lost to the secure desktop, a lock or a device disconnect, or another tool's
//! injected input would otherwise block a foreground takeover forever while nobody touches the
//! keyboard or mouse. Corroborated holds keep counting while still down, even without further
//! events: modifiers and stationary buttons repeat nothing. `STALE_AFTER_MS` is only a backstop
//! for async state stuck after a hook-seen down.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const STALE_AFTER_MS: u64 = 120_000;
pub const REPORT_LIMIT: usize = 8;

// Win32 values, kept here so the hook mapping is testable off Windows.
const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_SYSKEYUP: u32 = 0x0105;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
const WM_MBUTTONDOWN: u32 = 0x0207;
const WM_MBUTTONUP: u32 = 0x0208;
const WM_XBUTTONDOWN: u32 = 0x020B;
const WM_XBUTTONUP: u32 = 0x020C;
const LLKHF_INJECTED: u32 = 0x10;
const LLMHF_INJECTED: u32 = 0x01;
const XBUTTON1: u16 = 0x0001;
const VK_LBUTTON: u16 = 0x01;
const VK_RBUTTON: u16 = 0x02;
const VK_MBUTTON: u16 = 0x04;
const VK_XBUTTON1: u16 = 0x05;
const VK_XBUTTON2: u16 = 0x06;

/// One hook event, reduced to what held-input tracking needs. Codes are virtual-key codes;
/// mouse buttons use `VK_LBUTTON`, `VK_RBUTTON`, `VK_MBUTTON`, `VK_XBUTTON1` and `VK_XBUTTON2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeldEvent {
    Down(u16),
    Up(u16),
    Activity,
}

/// A `WH_KEYBOARD_LL` event (already known not to be F5's own); `None` when injected.
pub fn key_event(message: u32, vk: u32, flags: u32) -> Option<HeldEvent> {
    if flags & LLKHF_INJECTED != 0 {
        return None;
    }
    let code = vk as u16;
    Some(match message {
        WM_KEYDOWN | WM_SYSKEYDOWN => HeldEvent::Down(code),
        WM_KEYUP | WM_SYSKEYUP => HeldEvent::Up(code),
        _ => HeldEvent::Activity,
    })
}

/// A `WH_MOUSE_LL` event (already known not to be F5's own); `None` when injected. X buttons
/// are named by the high word of `mouseData`.
pub fn mouse_event(message: u32, mouse_data: u32, flags: u32) -> Option<HeldEvent> {
    if flags & LLMHF_INJECTED != 0 {
        return None;
    }
    let x = if (mouse_data >> 16) as u16 == XBUTTON1 {
        VK_XBUTTON1
    } else {
        VK_XBUTTON2
    };
    Some(match message {
        WM_LBUTTONDOWN => HeldEvent::Down(VK_LBUTTON),
        WM_LBUTTONUP => HeldEvent::Up(VK_LBUTTON),
        WM_RBUTTONDOWN => HeldEvent::Down(VK_RBUTTON),
        WM_RBUTTONUP => HeldEvent::Up(VK_RBUTTON),
        WM_MBUTTONDOWN => HeldEvent::Down(VK_MBUTTON),
        WM_MBUTTONUP => HeldEvent::Up(VK_MBUTTON),
        WM_XBUTTONDOWN => HeldEvent::Down(x),
        WM_XBUTTONUP => HeldEvent::Up(x),
        _ => HeldEvent::Activity,
    })
}

#[derive(Clone, Copy)]
struct Entry {
    since_ms: u64,
    /// Bumped on every new down, so reconciliation never drops a press it did not sample.
    revision: u64,
}

#[derive(Default)]
pub struct HeldInputTracker {
    downs: HashMap<u16, Entry>,
    last_physical_ms: Option<u64>,
    revision: u64,
}

impl HeldInputTracker {
    pub fn observe(&mut self, event: HeldEvent, now_ms: u64) {
        self.last_physical_ms = Some(now_ms);
        match event {
            HeldEvent::Down(code) => {
                // Auto-repeat keeps the original entry.
                if !self.downs.contains_key(&code) {
                    self.revision += 1;
                    self.downs.insert(
                        code,
                        Entry {
                            since_ms: now_ms,
                            revision: self.revision,
                        },
                    );
                }
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
    /// Entry revisions to check against async key state outside the caller's lock.
    pub fn sample(&self) -> HashMap<u16, u64> {
        self.downs
            .iter()
            .map(|(code, entry)| (*code, entry.revision))
            .collect()
    }
    /// Drops sampled entries the system reported released, unless pressed again since the
    /// sample, then returns the corroborated holds, oldest first.
    pub fn held(
        &mut self,
        now_ms: u64,
        sampled: &HashMap<u16, u64>,
        system_held: &HashSet<u16>,
    ) -> Vec<u16> {
        for (code, revision) in sampled {
            if !system_held.contains(code)
                && self.downs.get(code).map(|entry| entry.revision) == Some(*revision)
            {
                self.downs.remove(code);
            }
        }
        match self.last_physical_ms {
            Some(last) if now_ms.saturating_sub(last) <= STALE_AFTER_MS => {}
            _ => return Vec::new(),
        }
        let mut held: Vec<(u64, u16)> = self
            .downs
            .iter()
            .map(|(code, entry)| (entry.since_ms, *code))
            .collect();
        held.sort_unstable();
        held.into_iter()
            .take(REPORT_LIMIT)
            .map(|(_, code)| code)
            .collect()
    }
}

/// The async key codes that can confirm a hooked code. `GetAsyncKeyState` reads physical mouse
/// buttons, while hook messages may name logical ones; with swapped buttons either primary
/// physical button confirms a primary-button hold, so a real hold is never dropped.
pub fn system_codes(code: u16, swapped_buttons: bool) -> Vec<u16> {
    match (swapped_buttons, code) {
        (true, VK_LBUTTON | VK_RBUTTON) => vec![VK_LBUTTON, VK_RBUTTON],
        _ => vec![code],
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

    fn held_now(tracker: &mut HeldInputTracker, now_ms: u64, system: &[u16]) -> Vec<u16> {
        let sampled = tracker.sample();
        tracker.held(now_ms, &sampled, &system.iter().copied().collect())
    }

    #[test]
    fn down_then_up_is_not_held() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.observe(HeldEvent::Up(0x41), 10);
        assert!(held_now(&mut tracker, 20, &[0x41]).is_empty());
    }

    #[test]
    fn corroborated_hold_is_held_oldest_first() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0xA0), 0);
        tracker.observe(HeldEvent::Down(0x01), 5);
        tracker.observe(HeldEvent::Down(0xA0), 9); // auto-repeat keeps the first down time
        assert_eq!(held_now(&mut tracker, 10, &[0xA0, 0x01]), vec![0xA0, 0x01]);
    }

    #[test]
    fn system_hold_the_hook_never_saw_is_not_held() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Activity, 0);
        assert!(held_now(&mut tracker, 1, &[0xA0, 0x01]).is_empty());
    }

    #[test]
    fn hooked_hold_the_system_reports_released_is_dropped() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.observe(HeldEvent::Down(0xA0), 0);
        assert_eq!(held_now(&mut tracker, 1, &[0xA0]), vec![0xA0]);
        assert_eq!(held_now(&mut tracker, 2, &[0xA0, 0x41]), vec![0xA0]);
    }

    #[test]
    fn stationary_modifier_and_button_holds_keep_blocking_past_ten_seconds() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0xA2), 0);
        tracker.observe(HeldEvent::Down(0x01), 1);
        assert_eq!(
            held_now(&mut tracker, 60_000, &[0xA2, 0x01]),
            vec![0xA2, 0x01]
        );
        assert_eq!(
            held_now(&mut tracker, STALE_AFTER_MS, &[0xA2, 0x01]),
            vec![0xA2, 0x01]
        );
    }

    #[test]
    fn stuck_hold_stops_counting_only_after_the_long_backstop() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0xA2), 0);
        assert!(held_now(&mut tracker, STALE_AFTER_MS + 1, &[0xA2]).is_empty());
        tracker.observe(HeldEvent::Activity, 200_000);
        assert_eq!(held_now(&mut tracker, 200_001, &[0xA2]), vec![0xA2]);
    }

    #[test]
    fn release_and_repress_after_sampling_keeps_the_new_press() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x01), 0);
        let sampled = tracker.sample();
        tracker.observe(HeldEvent::Up(0x01), 10);
        tracker.observe(HeldEvent::Down(0x01), 11);
        assert_eq!(tracker.held(12, &sampled, &HashSet::new()), vec![0x01]);
        assert!(held_now(&mut tracker, 20, &[]).is_empty());
    }

    #[test]
    fn entries_hooked_after_the_sample_are_kept() {
        let mut tracker = HeldInputTracker::default();
        let sampled = tracker.sample();
        tracker.observe(HeldEvent::Down(0x41), 0);
        assert_eq!(tracker.held(1, &sampled, &HashSet::new()), vec![0x41]);
    }

    #[test]
    fn reset_clears_entries_and_activity() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.reset();
        assert!(tracker.sample().is_empty());
        assert!(held_now(&mut tracker, 1, &[0x41]).is_empty());
    }

    #[test]
    fn hook_mapping_ignores_injected_input_and_decodes_x_buttons() {
        assert_eq!(key_event(WM_KEYDOWN, 0x41, 0), Some(HeldEvent::Down(0x41)));
        assert_eq!(key_event(WM_SYSKEYUP, 0xA4, 0), Some(HeldEvent::Up(0xA4)));
        assert_eq!(key_event(WM_KEYDOWN, 0x41, LLKHF_INJECTED), None);
        assert_eq!(
            mouse_event(WM_LBUTTONDOWN, 0, 0),
            Some(HeldEvent::Down(VK_LBUTTON))
        );
        assert_eq!(
            mouse_event(WM_MBUTTONUP, 0, 0),
            Some(HeldEvent::Up(VK_MBUTTON))
        );
        assert_eq!(
            mouse_event(WM_XBUTTONDOWN, 1 << 16, 0),
            Some(HeldEvent::Down(VK_XBUTTON1))
        );
        assert_eq!(
            mouse_event(WM_XBUTTONUP, 2 << 16, 0),
            Some(HeldEvent::Up(VK_XBUTTON2))
        );
        assert_eq!(mouse_event(0x0200, 0, 0), Some(HeldEvent::Activity)); // WM_MOUSEMOVE
        assert_eq!(mouse_event(WM_RBUTTONDOWN, 0, LLMHF_INJECTED), None);
    }

    #[test]
    fn swapped_primary_buttons_are_confirmed_by_either_physical_button() {
        assert_eq!(system_codes(0x01, true), vec![0x01, 0x02]);
        assert_eq!(system_codes(0x02, true), vec![0x01, 0x02]);
        assert_eq!(system_codes(0x01, false), vec![0x01]);
        assert_eq!(system_codes(0x04, true), vec![0x04]);
        assert_eq!(system_codes(0xA0, true), vec![0xA0]);
    }

    #[test]
    fn report_is_capped_and_diagnostics_carry_codes_only() {
        let mut tracker = HeldInputTracker::default();
        let codes: Vec<u16> = (0x41..0x4D).collect();
        for code in &codes {
            tracker.observe(HeldEvent::Down(*code), u64::from(*code));
        }
        let held = held_now(&mut tracker, 100, &codes);
        assert_eq!(held.len(), REPORT_LIMIT);
        assert_eq!(held[0], 0x41);
        assert_eq!(diagnostic(0x41), json!({"kind": "key", "code": 0x41}));
        assert_eq!(diagnostic(0xA0)["kind"], "modifier");
        assert_eq!(diagnostic(0x05)["kind"], "button");
    }
}
