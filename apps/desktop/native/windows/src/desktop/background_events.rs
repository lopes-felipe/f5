use super::*;

fn foreground_required() -> Value {
    json!({"_tag":"ForegroundRequired","reason":"unsupported-in-background"})
}

unsafe fn observation(element: &IUIAutomationElement) -> Value {
    let value = element
        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
        .ok()
        .and_then(|pattern| pattern.CurrentValue().ok())
        .map(|value| value.to_string());
    let scroll = element
        .GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
        .ok()
        .and_then(|pattern| {
            Some((
                pattern.CurrentHorizontalScrollPercent().ok()?,
                pattern.CurrentVerticalScrollPercent().ok()?,
            ))
        });
    let selection = element
        .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
        .ok()
        .and_then(|pattern| pattern.GetSelection().ok())
        .and_then(|ranges| ranges.GetElement(0).ok())
        .and_then(|range| range.GetText(1000).ok())
        .map(|value| value.to_string());
    json!({"value":value,"scroll":scroll,"selection":selection})
}

/// No session keyboard-state changes: all messages and releases stay in the authorized GUI thread.
struct KeyRelease {
    hwnd: HWND,
    codes: Vec<u16>,
}
impl Drop for KeyRelease {
    fn drop(&mut self) {
        for code in self.codes.iter().rev() {
            unsafe {
                let _ = PostMessageW(
                    Some(self.hwnd),
                    WM_KEYUP,
                    WPARAM(*code as usize),
                    LPARAM(crate::safety::message_key_flags(
                        *code,
                        MapVirtualKeyW(*code as u32, MAPVK_VK_TO_VSC),
                        true,
                    )),
                );
            }
        }
    }
}
unsafe fn post(hwnd: HWND, message: u32, value: usize, flags: isize) -> Result<(), Value> {
    PostMessageW(Some(hwnd), message, WPARAM(value), LPARAM(flags))
        .map_err(|_| foreground_required())?;
    mark_posted();
    Ok(())
}
unsafe fn focused_element(
    root: &IUIAutomationElement,
    process: u32,
) -> Result<IUIAutomationElement, Value> {
    let (nodes, complete) = walk_checked(root, 4000);
    if !complete {
        return Err(blocked("focus-unknown"));
    }
    let mut focused = nodes.into_iter().filter(|element| {
        element.CurrentProcessId().ok().map(|pid| pid as u32) == Some(process)
            && element
                .CurrentHasKeyboardFocus()
                .is_ok_and(|value| value.as_bool())
    });
    let element = focused.next().ok_or(blocked("focus-unknown"))?;
    if focused.next().is_some() {
        return Err(blocked("focus-unknown"));
    }
    Ok(element)
}
unsafe fn focused_window(hwnd: HWND, process: u32) -> Result<(HWND, u32), Value> {
    let thread = GetWindowThreadProcessId(hwnd, None);
    let mut gui = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    GetGUIThreadInfo(thread, &mut gui).map_err(|_| foreground_required())?;
    if gui.hwndFocus.is_invalid() || owner(gui.hwndFocus)?.1 != process {
        return Err(blocked("focus-unknown"));
    }
    Ok((gui.hwndFocus, thread))
}

/// Per-window messages never call SendInput, SetFocus or SetForegroundWindow.
pub(super) unsafe fn execute(request: &Value, host: &Value, hwnd: HWND) -> Result<Value, Value> {
    if !crate::safety::background_event_app_allowed(s(request, "appId")) {
        return Err(json!({"_tag":"ForegroundRequired","reason":"unsupported-app"}));
    }
    let process = owner(hwnd)?.1;
    let automation = automation()?;
    let root = automation
        .ElementFromHandle(hwnd)
        .map_err(|_| foreground_required())?;
    let key = s(request, "op") == "key";
    let (element, destination, thread) = if key {
        let (focus, thread) = focused_window(hwnd, process)?;
        let element = focused_element(&root, process)?;
        (element, focus, thread)
    } else {
        if !request["x"].is_null() || !request["y"].is_null() {
            return Err(foreground_required());
        }
        let snapshot = snapshot(request)?;
        let element = snapshot_element(&snapshot, s(request, "elementRef"), &root)?;
        let native = element.CurrentNativeWindowHandle().unwrap_or(hwnd);
        let destination = if native.is_invalid() { hwnd } else { native };
        if owner(destination)?.1 != process {
            return Err(blocked("focus-unknown"));
        }
        (
            element,
            destination,
            GetWindowThreadProcessId(destination, None),
        )
    };
    if element
        .CurrentIsPassword()
        .map_err(|_| blocked("focus-unknown"))?
        .as_bool()
    {
        return Err(blocked("secure-field"));
    }
    authorize(
        destination,
        request,
        host,
        if key { "type" } else { "click" },
    )?;
    let before = observation(&element);
    let mut posted = false;
    let operation = (|| -> Result<(), Value> {
        if key {
            let chords = request["chords"].as_array().ok_or(foreground_required())?;
            if chords.is_empty() || chords.len() > 16 {
                return Err(foreground_required());
            }
            let codes = chords
                .iter()
                .map(|raw| chord(raw.as_str().unwrap_or("")))
                .collect::<Result<Vec<_>, _>>()?;
            if codes
                .iter()
                .any(|keys| !crate::safety::background_chord_supported(keys))
            {
                return Err(foreground_required());
            }
            for _ in 0..n(request, "repeat").clamp(1, 20) {
                for chord in &codes {
                    check(request)?;
                    if focused_window(hwnd, process)?.0 != destination
                        || owner(GetForegroundWindow())
                            .is_ok_and(|(id, _)| id.eq_ignore_ascii_case(s(request, "appId")))
                    {
                        return Err(blocked("user-active"));
                    }
                    let focused = focused_element(&root, process)?;
                    if focused
                        .CurrentIsPassword()
                        .map_err(|_| blocked("focus-unknown"))?
                        .as_bool()
                    {
                        return Err(blocked("secure-field"));
                    }
                    let mut release = KeyRelease {
                        hwnd: destination,
                        codes: Vec::new(),
                    };
                    // Printable text uses WM_CHAR alone: posting WM_KEYDOWN too would let
                    // TranslateMessage produce a second character using session keyboard state.
                    let mut characters = [0u16; 8];
                    let count = if !chord.contains(&VK_CONTROL.0) && !chord.contains(&VK_MENU.0) {
                        let mut state = [0u8; 256];
                        for code in chord {
                            state[*code as usize] = 0x80;
                        }
                        let code = *chord.last().ok_or(foreground_required())? as u32;
                        ToUnicodeEx(
                            code,
                            MapVirtualKeyW(code, MAPVK_VK_TO_VSC),
                            &state,
                            &mut characters,
                            4,
                            Some(GetKeyboardLayout(thread)),
                        )
                        .max(0) as usize
                    } else {
                        0
                    };
                    if count > 0
                        && characters
                            .iter()
                            .take(count)
                            .all(|character| *character >= 0x20)
                    {
                        for character in characters.iter().take(count) {
                            check(request)?;
                            post(destination, WM_CHAR, *character as usize, 1)?;
                            posted = true;
                        }
                        continue;
                    }
                    // Dead keys/layouts may not translate a nominally printable chord.
                    // Never fall back to key messages that discard Shift state.
                    if chord.contains(&VK_SHIFT.0) {
                        return Err(foreground_required());
                    }
                    for code in chord {
                        check(request)?;
                        let scan = MapVirtualKeyW(*code as u32, MAPVK_VK_TO_VSC);
                        post(
                            destination,
                            WM_KEYDOWN,
                            *code as usize,
                            crate::safety::message_key_flags(*code, scan, false),
                        )?;
                        posted = true;
                        release.codes.push(*code);
                    }
                    while let Some(code) = release.codes.last().copied() {
                        post(
                            destination,
                            WM_KEYUP,
                            code as usize,
                            crate::safety::message_key_flags(
                                code,
                                MapVirtualKeyW(code as u32, MAPVK_VK_TO_VSC),
                                true,
                            ),
                        )?;
                        release.codes.pop();
                    }
                }
            }
        } else {
            let bounds = element
                .CurrentBoundingRectangle()
                .map_err(|_| foreground_required())?;
            let x = (i64::from(bounds.left) + i64::from(bounds.right)) / 2;
            let y = (i64::from(bounds.top) + i64::from(bounds.bottom)) / 2;
            if bounds.right <= bounds.left
                || bounds.bottom <= bounds.top
                || i16::try_from(x).is_err()
                || i16::try_from(y).is_err()
            {
                return Err(foreground_required());
            }
            let point = (x as u16 as u32) | ((y as u16 as u32) << 16);
            for (axis, message, sign) in [
                ("deltaY", WM_MOUSEWHEEL, -1.0),
                ("deltaX", WM_MOUSEHWHEEL, 1.0),
            ] {
                let delta = (request[axis].as_f64().unwrap_or(0.0).clamp(-50.0, 50.0)
                    * 120.0
                    * sign) as i16;
                if delta == 0 {
                    continue;
                }
                check(request)?;
                let snapshot = snapshot(request)?;
                snapshot_validate(&snapshot, request)?;
                post(
                    destination,
                    message,
                    ((delta as u16 as u32) << 16) as usize,
                    point as isize,
                )?;
                posted = true;
            }
        }
        Ok(())
    })();
    if let Err(error) = operation {
        return Err(if posted {
            fail("OutcomeUnknown")
        } else {
            error
        });
    }
    std::thread::sleep(Duration::from_millis(50));
    let after = observation(&element);
    let readable = before
        .as_object()
        .is_some_and(|values| values.values().any(|value| !value.is_null()));
    Ok(json!({"readBack":readable,"verified":readable && before != after}))
}
