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
pub fn hooks_healthy(mouse_ack: u64, keyboard_ack: u64, sent: u64) -> bool {
    mouse_ack >= sent && keyboard_ack >= sent
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
        assert!(hooks_healthy(20, 20, 20));
        assert!(!hooks_healthy(20, 19, 20));
        assert!(!hooks_healthy(19, 20, 20));
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
            "arrowleft" => 0x25,
            "arrowright" => 0x27,
            "arrowup" => 0x26,
            "arrowdown" => 0x28,
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
    if codes.contains(&0x5b) && (codes.contains(&(b'L' as u16)) || codes.contains(&(b'R' as u16)))
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
    fn protected_and_kill_chords_cannot_be_injected() {
        for chord in ["Ctrl+Alt+Delete", "win+l", "Meta+R", "Ctrl+Alt+Shift+F12"] {
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
}
