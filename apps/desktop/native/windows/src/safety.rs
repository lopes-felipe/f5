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
pub fn inside_frame(x: i32, y: i32, left: i32, top: i32, right: i32, bottom: i32) -> bool {
    x >= left && y >= top && x < right && y < bottom
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
    #[test]
    fn invisible_borders_are_cropped_without_shifting_content() {
        // PrintWindow pixel (7,7) from full-window origin (93,93) belongs at (100,100).
        assert!(inside_frame(93 + 7, 93 + 7, 100, 100, 300, 300));
        assert!(!inside_frame(93, 93, 100, 100, 300, 300));
        assert!(!inside_frame(300, 100, 100, 100, 300, 300));
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
