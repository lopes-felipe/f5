//! Held physical input, corroborated twice: the low-level hook saw the down (not injected, not
//! F5's own) and `GetAsyncKeyState` still reports it. Async key state alone has no owner or age:
//! a key-up lost to the secure desktop, a lock or a device disconnect, or another tool's
//! injected input would otherwise block a foreground takeover forever while nobody touches the
//! keyboard or mouse. A corroborated modifier or mouse button counts for as long as the system
//! reports it: a stationary press or a paused drag sends no further events. Ordinary keys
//! repeat while held, so a key hold with no physical input of any kind for `STALE_AFTER_MS`
//! stops counting, a backstop for async key state stuck down.
use serde_json::{json, Value};
use std::collections::HashMap;

/// Applies to ordinary keys only.
pub const STALE_AFTER_MS: u64 = 120_000;
pub const REPORT_LIMIT: usize = 8;

const VK_LBUTTON: u16 = 0x01;
const VK_RBUTTON: u16 = 0x02;
const VK_MBUTTON: u16 = 0x04;
const VK_XBUTTON1: u16 = 0x05;
const VK_XBUTTON2: u16 = 0x06;
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

/// One hook event, reduced to what held-input tracking needs. Codes are virtual-key codes;
/// mouse buttons use `VK_LBUTTON`, `VK_RBUTTON`, `VK_MBUTTON`, `VK_XBUTTON1` and `VK_XBUTTON2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HeldEvent {
    Down(u16),
    Up(u16),
    Activity,
}

/// The `WH_KEYBOARD_LL` event, or `None` for injected input, which is never physical.
pub fn key_event(message: u32, vk: u16, injected: bool) -> Option<HeldEvent> {
    if injected {
        return None;
    }
    Some(match message {
        WM_KEYDOWN | WM_SYSKEYDOWN => HeldEvent::Down(vk),
        WM_KEYUP | WM_SYSKEYUP => HeldEvent::Up(vk),
        _ => HeldEvent::Activity,
    })
}

/// The `WH_MOUSE_LL` event, or `None` for injected input. X buttons are named by the high word
/// of `mouse_data`; an unknown X button is activity, never a hold.
pub fn mouse_event(message: u32, mouse_data: u32, injected: bool) -> Option<HeldEvent> {
    if injected {
        return None;
    }
    let x = match (mouse_data >> 16) as u16 {
        1 => Some(VK_XBUTTON1),
        2 => Some(VK_XBUTTON2),
        _ => None,
    };
    Some(match (message, x) {
        (WM_LBUTTONDOWN, _) => HeldEvent::Down(VK_LBUTTON),
        (WM_LBUTTONUP, _) => HeldEvent::Up(VK_LBUTTON),
        (WM_RBUTTONDOWN, _) => HeldEvent::Down(VK_RBUTTON),
        (WM_RBUTTONUP, _) => HeldEvent::Up(VK_RBUTTON),
        (WM_MBUTTONDOWN, _) => HeldEvent::Down(VK_MBUTTON),
        (WM_MBUTTONUP, _) => HeldEvent::Up(VK_MBUTTON),
        (WM_XBUTTONDOWN, Some(x)) => HeldEvent::Down(x),
        (WM_XBUTTONUP, Some(x)) => HeldEvent::Up(x),
        _ => HeldEvent::Activity,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Key,
    Modifier,
    Button,
}

fn kind(code: u16) -> Kind {
    match code {
        0x01 | 0x02 | 0x04 | 0x05 | 0x06 => Kind::Button,
        0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5 => Kind::Modifier,
        _ => Kind::Key,
    }
}

/// When a tracked down happened, and a revision that changes whenever the entry is re-added.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Down {
    at_ms: u64,
    revision: u64,
}

#[derive(Default)]
pub struct HeldInputTracker {
    downs: HashMap<u16, Down>,
    last_physical_ms: Option<u64>,
    revision: u64,
}

impl HeldInputTracker {
    pub fn observe(&mut self, event: HeldEvent, now_ms: u64) {
        self.last_physical_ms = Some(now_ms);
        match event {
            HeldEvent::Down(code) => {
                // A repeated down keeps the original entry, its time and its revision.
                if !self.downs.contains_key(&code) {
                    self.revision += 1;
                    let revision = self.revision;
                    self.downs.insert(
                        code,
                        Down {
                            at_ms: now_ms,
                            revision,
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
    /// Tracked codes with their revisions, to query the system outside the state lock.
    pub fn sample(&self) -> Vec<(u16, u64)> {
        self.downs
            .iter()
            .map(|(code, down)| (*code, down.revision))
            .collect()
    }
    /// Holds the hook saw and the system still reports, oldest first. `released` lists sampled
    /// entries the system then reported released, with their sampled revisions. Each is dropped
    /// only if unchanged since sampling, so a release and re-press in between keeps the new hold.
    pub fn held(&mut self, now_ms: u64, released: &[(u16, u64)]) -> Vec<u16> {
        for (code, revision) in released {
            if self.downs.get(code).map(|down| down.revision) == Some(*revision) {
                self.downs.remove(code);
            }
        }
        let keys_stale = self
            .last_physical_ms
            .is_none_or(|last| now_ms.saturating_sub(last) > STALE_AFTER_MS);
        let mut held: Vec<(u64, u16)> = self
            .downs
            .iter()
            .filter(|(code, _)| !(keys_stale && kind(**code) == Kind::Key))
            .map(|(code, down)| (down.at_ms, *code))
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
        (true, 0x01 | 0x02) => vec![0x01, 0x02],
        _ => vec![code],
    }
}

/// Diagnostic only: virtual-key codes, never characters.
pub fn diagnostic(code: u16) -> Value {
    let kind = match kind(code) {
        Kind::Button => "button",
        Kind::Modifier => "modifier",
        Kind::Key => "key",
    };
    json!({"kind": kind, "code": code})
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Samples, asks `system` about each entry, then reconciles, as the helper does.
    fn held(tracker: &mut HeldInputTracker, now_ms: u64, system: impl Fn(u16) -> bool) -> Vec<u16> {
        let released: Vec<(u16, u64)> = tracker
            .sample()
            .into_iter()
            .filter(|(code, _)| !system(*code))
            .collect();
        tracker.held(now_ms, &released)
    }

    #[test]
    fn down_then_up_is_not_held() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.observe(HeldEvent::Up(0x41), 10);
        assert!(held(&mut tracker, 20, |_| true).is_empty());
    }

    #[test]
    fn corroborated_recent_hold_is_held_oldest_first() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0xA0), 0);
        tracker.observe(HeldEvent::Down(0x01), 5);
        tracker.observe(HeldEvent::Down(0xA0), 9); // auto-repeat keeps the first down time
        assert_eq!(held(&mut tracker, 10, |_| true), vec![0xA0, 0x01]);
    }

    #[test]
    fn system_hold_the_hook_never_saw_is_not_held() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Activity, 0);
        assert!(held(&mut tracker, 1, |_| true).is_empty());
    }

    #[test]
    fn hooked_hold_the_system_reports_released_is_dropped() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.observe(HeldEvent::Down(0xA0), 0);
        assert_eq!(held(&mut tracker, 1, |code| code == 0xA0), vec![0xA0]);
        assert_eq!(held(&mut tracker, 2, |_| true), vec![0xA0]);
    }

    #[test]
    fn release_and_repress_during_reconciliation_keeps_the_new_hold() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x01), 0);
        // Sampled, then the async state query sees it released...
        let released = tracker.sample();
        // ...while the user releases and presses it again before reconciliation.
        tracker.observe(HeldEvent::Up(0x01), 1);
        tracker.observe(HeldEvent::Down(0x01), 2);
        assert_eq!(tracker.held(3, &released), vec![0x01]);
        // An entry unchanged since sampling is dropped.
        let released = tracker.sample();
        assert!(tracker.held(4, &released).is_empty());
    }

    #[test]
    fn stationary_modifier_and_button_holds_never_go_stale() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0xA2), 0);
        tracker.observe(HeldEvent::Down(0x01), 0);
        assert_eq!(
            held(&mut tracker, STALE_AFTER_MS * 10, |_| true),
            vec![0x01, 0xA2]
        );
    }

    #[test]
    fn key_hold_without_recent_physical_input_stops_counting() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        assert_eq!(held(&mut tracker, STALE_AFTER_MS, |_| true), vec![0x41]);
        assert!(held(&mut tracker, STALE_AFTER_MS + 1, |_| true).is_empty());
        tracker.observe(HeldEvent::Activity, 200_000);
        assert_eq!(held(&mut tracker, 200_001, |_| true), vec![0x41]);
    }

    #[test]
    fn reset_clears_entries_and_activity() {
        let mut tracker = HeldInputTracker::default();
        tracker.observe(HeldEvent::Down(0x41), 0);
        tracker.reset();
        assert!(tracker.sample().is_empty());
        assert!(held(&mut tracker, 1, |_| true).is_empty());
    }

    #[test]
    fn hook_messages_map_to_held_events_and_injected_input_is_ignored() {
        assert_eq!(
            key_event(WM_KEYDOWN, 0x41, false),
            Some(HeldEvent::Down(0x41))
        );
        assert_eq!(
            key_event(WM_SYSKEYDOWN, 0xA4, false),
            Some(HeldEvent::Down(0xA4))
        );
        assert_eq!(
            key_event(WM_SYSKEYUP, 0xA4, false),
            Some(HeldEvent::Up(0xA4))
        );
        assert_eq!(key_event(WM_KEYDOWN, 0x41, true), None);
        assert_eq!(
            mouse_event(WM_LBUTTONDOWN, 0, false),
            Some(HeldEvent::Down(0x01))
        );
        assert_eq!(
            mouse_event(WM_RBUTTONUP, 0, false),
            Some(HeldEvent::Up(0x02))
        );
        assert_eq!(
            mouse_event(WM_MBUTTONDOWN, 0, false),
            Some(HeldEvent::Down(0x04))
        );
        assert_eq!(
            mouse_event(WM_XBUTTONDOWN, 1 << 16, false),
            Some(HeldEvent::Down(0x05))
        );
        assert_eq!(
            mouse_event(WM_XBUTTONUP, 2 << 16, false),
            Some(HeldEvent::Up(0x06))
        );
        assert_eq!(
            mouse_event(WM_XBUTTONDOWN, 3 << 16, false),
            Some(HeldEvent::Activity)
        );
        assert_eq!(mouse_event(0x0200, 0, false), Some(HeldEvent::Activity));
        assert_eq!(mouse_event(WM_LBUTTONDOWN, 0, true), None);
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
        for code in 0x41..0x4D {
            tracker.observe(HeldEvent::Down(code), code as u64);
        }
        let held = held(&mut tracker, 100, |_| true);
        assert_eq!(held.len(), REPORT_LIMIT);
        assert_eq!(held[0], 0x41);
        assert_eq!(diagnostic(0x41), json!({"kind": "key", "code": 0x41}));
        assert_eq!(diagnostic(0xA0)["kind"], "modifier");
        assert_eq!(diagnostic(0x05)["kind"], "button");
    }
}
