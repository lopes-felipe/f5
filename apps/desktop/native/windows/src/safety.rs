pub const INPUT_MARK: usize = 0xF5C0;
pub const PROBE_MARK: usize = 0xF5C1;

/// None is a non-activity packet; true is motion; false is a button/wheel event.
pub fn raw_mouse_activity(
    extra: u32,
    buttons: u16,
    absolute: bool,
    x: i32,
    y: i32,
) -> Option<bool> {
    if extra == INPUT_MARK as u32 || extra == PROBE_MARK as u32 {
        None
    } else if buttons != 0 {
        Some(false)
    } else if absolute || x != 0 || y != 0 {
        Some(true)
    } else {
        None
    }
}
pub fn restrict_tier<'a>(a: &'a str, b: &'a str) -> &'a str {
    let tiers = ["blocked", "view", "click", "full"];
    let rank = |tier| tiers.iter().position(|value| *value == tier).unwrap_or(0);
    if rank(a) <= rank(b) {
        a
    } else {
        b
    }
}
use serde_json::Value;
use std::sync::OnceLock;
pub fn app_tier(id: &str) -> String {
    static TABLE: OnceLock<Value> = OnceLock::new();
    let table = TABLE
        .get_or_init(|| serde_json::from_str(include_str!("../../computer-tiers.json")).unwrap());
    let lower = id.to_lowercase();
    let basename = lower.rsplit(['\\', '/']).next().unwrap_or(&lower);
    for tier in ["blocked", "view", "click"] {
        for pattern in table["tiers"]["win32"][tier].as_array().unwrap() {
            let p = pattern.as_str().unwrap();
            for candidate in [&lower[..], basename] {
                if if let Some(prefix) = p.strip_suffix('*') {
                    candidate.starts_with(prefix)
                } else {
                    candidate == p
                } {
                    return tier.to_string();
                }
            }
        }
    }
    if basename == "applicationframehost.exe" {
        "blocked".into()
    } else {
        "full".into()
    }
}
pub fn grant_allows(tier: &str, allow_typing: bool, needed: &str) -> bool {
    if !matches!(tier, "view" | "click" | "full") {
        return false;
    }
    if needed == "view" {
        return true;
    }
    if tier == "view" {
        return false;
    }
    needed == "click" || (needed == "type" && (tier == "full" || allow_typing))
}
pub fn background_event_app_allowed(app: &str) -> bool {
    static TABLE: OnceLock<Value> = OnceLock::new();
    let table = TABLE
        .get_or_init(|| serde_json::from_str(include_str!("../../computer-tiers.json")).unwrap());
    #[cfg(debug_assertions)]
    if std::env::args().any(|arg| arg == format!("--rehearse-background-events={app}"))
        && table["backgroundEventCandidates"]["win32"]
            .as_array()
            .is_some_and(|apps| {
                apps.iter()
                    .any(|id| id.as_str().is_some_and(|id| id.eq_ignore_ascii_case(app)))
            })
    {
        return true;
    }
    table["backgroundEvents"]["win32"]
        .as_array()
        .is_some_and(|apps| {
            apps.iter()
                .any(|id| id.as_str().is_some_and(|id| id.eq_ignore_ascii_case(app)))
        })
}
pub fn input_monitors_healthy(
    mouse_registered: bool,
    mouse_responsive: bool,
    keyboard_queued: bool,
    keyboard_ack: u64,
    sent: u64,
) -> bool {
    mouse_registered && mouse_responsive && keyboard_queued && keyboard_ack >= sent
}
/// Alt can cause F12 to arrive as WM_SYSKEYDOWN rather than WM_KEYDOWN.
pub fn stop_chord(message: u32, key: u32, control: bool, alt: bool, shift: bool) -> bool {
    matches!(message, 0x100 | 0x104) && key == 0x7b && control && alt && shift
}
pub fn insert_selected_text(
    prior: &str,
    prefix: &str,
    selected: &str,
    suffix: &str,
    text: &str,
) -> Option<String> {
    if prior.len() > 40000 || [prefix, selected, suffix].concat() != prior {
        return None;
    }
    Some([prefix, text, suffix].concat())
}
pub fn input_conflicts(
    background: bool,
    pointer_move: bool,
    target_window: u64,
    target_pid: u64,
    event_window: u64,
    event_pid: u64,
) -> bool {
    !background
        || (!pointer_move
            && (event_window == 0
                || target_window == event_window
                || (target_pid != 0 && target_pid == event_pid)))
}
/// No rectangular authorization for windows whose input recipient is uncertain.
pub fn input_target_is_certain(
    visible: bool,
    minimized: bool,
    cloaked: bool,
    overlay: bool,
    transparent: bool,
    layered: bool,
    in_region: bool,
) -> bool {
    visible && !minimized && !cloaked && !overlay && !transparent && !layered && in_region
}
pub fn system_process(executable: &str) -> bool {
    let lower = executable.to_lowercase();
    matches!(
        lower.rsplit(['\\', '/']).next().unwrap_or(&lower),
        "shellexperiencehost.exe" | "startmenuexperiencehost.exe"
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn posted_keys_cannot_silently_drop_shortcut_modifiers() {
        for raw in ["Control+A", "Control+Z", "Alt+A", "Shift+Left", "Shift+Tab"] {
            assert!(
                !background_chord_supported(&parse_chord(raw).unwrap()),
                "{raw}"
            );
        }
        for raw in ["Shift+A", "Down", "x"] {
            assert!(
                background_chord_supported(&parse_chord(raw).unwrap()),
                "{raw}"
            );
        }
    }
    #[test]
    fn window_key_messages_include_extended_scan_and_balanced_release_bits() {
        assert_eq!(message_key_flags(0x41, 0x1e, false) as u32, 0x001e0001);
        assert_eq!(message_key_flags(0x25, 0x4b, true) as u32, 0xc14b0001);
        assert!(!background_event_app_allowed("unverified.example.exe"));
    }
    #[test]
    fn stop_chord_recognizes_system_keydown_and_never_keyup_or_partial_modifiers() {
        assert!(stop_chord(0x100, 0x7b, true, true, true));
        assert!(stop_chord(0x104, 0x7b, true, true, true));
        assert!(!stop_chord(0x105, 0x7b, true, true, true));
        assert!(!stop_chord(0x104, 0x7b, true, false, true));
        assert!(!stop_chord(0x104, 0x7a, true, true, true));
    }
    #[test]
    fn inserts_at_the_selection_and_rejects_inconsistent_or_truncated_ranges() {
        assert_eq!(
            insert_selected_text("hello world", "hello ", "world", "", "Ω🙂").as_deref(),
            Some("hello Ω🙂")
        );
        assert_eq!(
            insert_selected_text("hello world", "hello", "", " world", "!").as_deref(),
            Some("hello! world")
        );
        assert_eq!(insert_selected_text("private", "", "other", "", "x"), None);
        assert_eq!(
            insert_selected_text("hello world", "", "hello", "", "x"),
            None
        );
    }
    #[test]
    fn background_input_conflicts_are_local_and_fail_closed_on_unknown_recipients() {
        assert!(!input_conflicts(true, true, 10, 20, 10, 20));
        assert!(!input_conflicts(true, false, 10, 20, 11, 21));
        assert!(input_conflicts(true, false, 10, 20, 10, 21));
        assert!(input_conflicts(true, false, 10, 20, 11, 20));
        assert!(input_conflicts(true, false, 10, 20, 0, 0));
        assert!(input_conflicts(false, true, 10, 20, 11, 21));
    }
    #[test]
    fn executable_identity_can_only_narrow_a_packaged_app_tier() {
        assert_eq!(restrict_tier("full", "view"), "view");
        assert_eq!(restrict_tier("full", "blocked"), "blocked");
        assert_eq!(restrict_tier("click", "full"), "click");
    }
    #[test]
    fn catalog_blocks_other_f5_and_packaged_shell_instances() {
        for app in [
            "C:\\Apps\\F5 (Alpha).exe",
            "C:\\Apps\\F5 (Beta).exe",
            "microsoft.windows.shellexperiencehost_cw5n1h2txyewy!app",
            "microsoft.windows.startmenuexperiencehost_cw5n1h2txyewy!app",
            "C:\\Windows\\ApplicationFrameHost.exe",
        ] {
            assert_eq!(app_tier(app), "blocked");
        }
        assert_eq!(
            app_tier("microsoft.windowscalculator_8wekyb3d8bbwe!app"),
            "full"
        );
    }
    #[test]
    fn ownership_change_stops_drag_before_next_event() {
        let mut emitted = 0;
        for step in 0..12 {
            let tier = if step < 4 { "full" } else { "blocked" };
            if !grant_allows(tier, false, "click") {
                break;
            }
            emitted += 1;
        }
        assert_eq!(emitted, 4);
        assert!(!grant_allows("view", true, "click"));
        assert!(!grant_allows("click", false, "type"));
        assert!(grant_allows("click", true, "type"));
    }
    #[test]
    fn either_missing_hook_fails_health_check() {
        assert!(input_monitors_healthy(true, true, true, 20, 20));
        assert!(!input_monitors_healthy(true, true, true, 19, 20));
        assert!(!input_monitors_healthy(true, false, true, 20, 20));
        assert!(!input_monitors_healthy(false, true, true, 20, 20));
        assert!(!input_monitors_healthy(true, true, false, 20, 20));
    }
    #[test]
    fn raw_mouse_ignores_own_input_and_distinguishes_motion_from_buttons() {
        for extra in [INPUT_MARK as u32, PROBE_MARK as u32] {
            assert_eq!(raw_mouse_activity(extra, 1, false, 100, 100), None);
        }
        assert_eq!(raw_mouse_activity(0, 0, false, 0, 0), None);
        assert_eq!(raw_mouse_activity(0, 0, false, -10, 0), Some(true));
        assert_eq!(raw_mouse_activity(0, 0, true, 0, 0), Some(true));
        assert_eq!(raw_mouse_activity(0, 1, false, 0, 0), Some(false));
        assert_eq!(raw_mouse_activity(0, 0x400, false, 0, 0), Some(false));
        assert_eq!(raw_mouse_activity(0, 1, false, 20, 20), Some(false));
    }
    #[test]
    fn rejects_cloaked_click_through_layered_regions_and_overlays() {
        assert!(input_target_is_certain(
            true, false, false, false, false, false, true
        ));
        for i in 0..7 {
            let mut fields = [true, false, false, false, false, false, true];
            fields[i] = !fields[i];
            assert!(!input_target_is_certain(
                fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6]
            ));
        }
    }
    #[test]
    fn packaged_shell_keeps_executable_protection_identity() {
        assert!(system_process(
            "C:\\Windows\\SystemApps\\package\\ShellExperienceHost.exe"
        ));
        assert!(system_process(
            "C:\\Windows\\SystemApps\\package\\StartMenuExperienceHost.exe"
        ));
        assert!(!system_process("C:\\Apps\\Calculator.exe"));
    }
}

#[derive(Debug, PartialEq)]
pub enum ReleasedInput {
    Key(u16),
    Unicode(u16),
    Button(u16),
}
pub fn drain_held_inputs(
    held: &mut std::collections::HashSet<u16>,
    unicode: &mut std::collections::HashSet<u16>,
) -> Vec<ReleasedInput> {
    unicode
        .drain()
        .map(ReleasedInput::Unicode)
        .chain(held.drain().map(|code| {
            if code >= 0xff00 {
                ReleasedInput::Button(code)
            } else {
                ReleasedInput::Key(code)
            }
        }))
        .collect()
}
#[cfg(test)]
mod release_tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn cancellation_releases_each_held_input_once() {
        let mut held = HashSet::from([0x11, 0xff00]);
        let mut unicode = HashSet::from([0xd83d]);
        let released = drain_held_inputs(&mut held, &mut unicode);
        assert_eq!(released.len(), 3);
        assert!(released.contains(&ReleasedInput::Key(0x11)));
        assert!(released.contains(&ReleasedInput::Button(0xff00)));
        assert!(released.contains(&ReleasedInput::Unicode(0xd83d)));
        assert!(drain_held_inputs(&mut held, &mut unicode).is_empty());
    }
}

/// LPARAM for process-directed key messages, including navigation's extended-key bit.
pub fn background_chord_supported(keys: &[u16]) -> bool {
    !keys.contains(&0x11)
        && !keys.contains(&0x12)
        && (!keys.contains(&0x10)
            || keys.last().is_some_and(
                |key| matches!(*key, 0x20 | 0x30..=0x39 | 0x41..=0x5a | 0xba..=0xc0 | 0xdb..=0xde),
            ))
}
pub fn message_key_flags(code: u16, scan: u32, up: bool) -> isize {
    let extended = matches!(code, 0x21..=0x28 | 0x2d | 0x2e | 0xa3 | 0xa5);
    (1u32
        | ((scan & 0xff) << 16)
        | if extended { 1 << 24 } else { 0 }
        | if up { 3 << 30 } else { 0 }) as isize
}
pub fn parse_chord(raw: &str) -> Result<Vec<u16>, &'static str> {
    let parts: Vec<_> = raw.split('+').map(|part| part.to_lowercase()).collect();
    let mut codes = Vec::new();
    for part in &parts {
        let code = match &part[..] {
            "ctrl" | "control" => 0x11,
            "alt" => 0x12,
            "shift" => 0x10,
            "win" | "meta" => 0x5b,
            "enter" | "return" => 0xd,
            "tab" => 0x9,
            "escape" | "esc" => 0x1b,
            "space" => 0x20,
            "backspace" => 0x8,
            "delete" => 0x2e,
            "arrowleft" | "left" => 0x25,
            "arrowright" | "right" => 0x27,
            "arrowup" | "up" => 0x26,
            "arrowdown" | "down" => 0x28,
            "minus" | "-" => 0xbd,
            "equal" | "=" | "plus" => 0xbb,
            "bracketleft" | "[" => 0xdb,
            "bracketright" | "]" => 0xdd,
            "semicolon" | ";" => 0xba,
            "quote" | "'" => 0xde,
            "comma" | "," => 0xbc,
            "period" | "." => 0xbe,
            "slash" | "/" => 0xbf,
            "backslash" | "\\" => 0xdc,
            "backquote" | "`" => 0xc0,
            "home" => 0x24,
            "end" => 0x23,
            "pageup" => 0x21,
            "pagedown" => 0x22,
            _ => {
                if part.len() == 1 && part.as_bytes()[0].is_ascii_alphanumeric() {
                    part.as_bytes()[0].to_ascii_uppercase() as u16
                } else if part.starts_with('f') {
                    let number = part[1..].parse::<u16>().map_err(|_| "UnsupportedAction")?;
                    if !(1..=12).contains(&number) {
                        return Err("UnsupportedAction");
                    }
                    0x70 + number - 1
                } else {
                    return Err("UnsupportedAction");
                }
            }
        };
        codes.push(code)
    }
    if codes.contains(&0x5b)
        || codes.contains(&0x11) && codes.contains(&0x1b)
        || codes.contains(&0x11) && codes.contains(&0x12) && codes.contains(&0x2e)
        || codes.contains(&0x11)
            && codes.contains(&0x12)
            && codes.contains(&0x10)
            && codes.contains(&0x7b)
    {
        return Err("system-ui");
    }
    Ok(codes)
}

pub fn focused_element_block(
    owner_pid: u32,
    element_pid: Option<u32>,
    password: Option<bool>,
) -> Option<&'static str> {
    match password {
        None => return Some("focus-unknown"),
        Some(true) => return Some("secure-field"),
        Some(false) => (),
    }
    match element_pid {
        None => Some("owner-unknown"),
        Some(pid) if pid != owner_pid => Some("focus-unknown"),
        _ => None,
    }
}

#[cfg(test)]
mod keyboard_tests {
    use super::*;
    #[test]
    fn punctuation_and_arrow_aliases() {
        for (aliases, code) in [
            ("up|arrowup", 0x26),
            ("down|arrowdown", 0x28),
            ("left|arrowleft", 0x25),
            ("right|arrowright", 0x27),
            ("minus|-", 0xbd),
            ("equal|=|plus", 0xbb),
            ("bracketleft|[", 0xdb),
            ("bracketright|]", 0xdd),
            ("semicolon|;", 0xba),
            ("quote|'", 0xde),
            ("comma|,", 0xbc),
            ("period|.", 0xbe),
            ("slash|/", 0xbf),
            ("backslash|\\", 0xdc),
            ("backquote|`", 0xc0),
        ] {
            for name in aliases.split('|') {
                assert_eq!(parse_chord(&name.to_uppercase()), Ok(vec![code]));
            }
        }
        assert_eq!(parse_chord("Ctrl+Minus"), Ok(vec![0x11, 0xbd]));
        assert_eq!(parse_chord("Ctrl+="), Ok(vec![0x11, 0xbb]));
        for number in 1..=12 {
            assert_eq!(
                parse_chord(&format!("F{number}")),
                Ok(vec![0x70 + number - 1])
            );
        }
    }
    #[test]
    fn protected_and_kill_chords_cannot_be_injected() {
        for chord in [
            "Ctrl+Alt+Delete",
            "win+l",
            "Meta+R",
            "Ctrl+Alt+Shift+F12",
            "Meta",
            "Meta+I",
            "Meta+E",
            "Meta+X",
            "Ctrl+Esc",
        ] {
            assert_eq!(parse_chord(chord), Err("system-ui"));
        }
        assert_eq!(parse_chord("CTRL+a"), Ok(vec![0x11, 0x41]));
        assert_eq!(
            parse_chord("Ctrl+Shift+ArrowLeft"),
            Ok(vec![0x11, 0x10, 0x25])
        );
        assert_eq!(parse_chord("Alt+F13"), Err("UnsupportedAction"));
        assert_eq!(parse_chord("Ctrl+unsupported"), Err("UnsupportedAction"));
    }
    #[test]
    fn unknown_and_secure_focus_fail_closed_before_typing_or_set_value() {
        assert_eq!(focused_element_block(20, Some(20), Some(false)), None);
        assert_eq!(
            focused_element_block(20, Some(20), None),
            Some("focus-unknown")
        );
        assert_eq!(
            focused_element_block(20, None, Some(false)),
            Some("owner-unknown")
        );
        assert_eq!(
            focused_element_block(20, Some(21), Some(false)),
            Some("focus-unknown")
        );
        assert_eq!(
            focused_element_block(20, Some(20), Some(true)),
            Some("secure-field")
        );
    }
    #[test]
    fn focused_owner_or_password_change_stops_before_the_next_event() {
        for changed in [
            (Some(21), Some(false)),
            (Some(20), Some(true)),
            (Some(20), None),
        ] {
            let states = [(Some(20), Some(false)), changed];
            let delivered = states
                .iter()
                .take_while(|(pid, password)| focused_element_block(20, *pid, *password).is_none())
                .count();
            assert_eq!(delivered, 1);
        }
    }
    #[test]
    fn independently_removed_hooks_cannot_borrow_the_other_acknowledgement() {
        for probe in 1..100 {
            assert!(!input_monitors_healthy(true, true, true, probe - 1, probe));
            assert!(!input_monitors_healthy(true, false, true, probe, probe));
            assert!(input_monitors_healthy(true, true, true, probe, probe));
        }
    }
}

/// Validation precedes every Unicode character, even within one 32-character chunk.
pub fn deliver_characters<E>(
    characters: impl IntoIterator<Item = char>,
    mut validate: impl FnMut() -> Result<(), E>,
    mut emit: impl FnMut(char) -> Result<(), E>,
) -> Result<(), E> {
    for character in characters {
        validate()?;
        emit(character)?;
    }
    Ok(())
}
#[cfg(test)]
mod character_delivery_tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn changed_focus_in_the_same_window_stops_after_one_character() {
        let focus = Cell::new(1);
        let mut delivered = String::new();
        let result = deliver_characters(
            "first chunk".chars(),
            || {
                if focus.get() == 1 {
                    Ok(())
                } else {
                    Err("focus-unknown")
                }
            },
            |character| {
                delivered.push(character);
                focus.set(2);
                Ok(())
            },
        );
        assert_eq!(result, Err("focus-unknown"));
        assert_eq!(delivered, "f");
    }
    #[test]
    fn rejected_shell_chords_emit_no_input() {
        for chord in ["Meta", "Meta+I", "Meta+E", "Meta+X", "Ctrl+Esc"] {
            let mut events = 0;
            if let Ok(codes) = parse_chord(chord) {
                events += codes.len();
            }
            assert_eq!(events, 0);
        }
    }
}
