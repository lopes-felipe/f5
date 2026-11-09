use super::*;
thread_local! { static POSTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
pub(super) fn reset_posted() {
    POSTED.with(|posted| posted.set(false));
}
pub(super) fn mark_posted() {
    POSTED.with(|posted| posted.set(true));
}
pub(super) fn action_posted() -> bool {
    POSTED.with(|posted| posted.get())
}

pub(super) unsafe fn hit(point: POINT, request: &Value, host: &Value) -> Result<(), Value> {
    check(request)?;
    if !s(request, "geometryGeneration").is_empty()
        && select_display(request)?.generation != s(request, "geometryGeneration")
    {
        return Err(fail("GeometryChanged"));
    }
    // WindowFromPoint follows the desktop's real hit test; rectangles alone do not.
    let recipient = WindowFromPoint(point);
    let hwnd = GetAncestor(recipient, GA_ROOT);
    if hwnd.0.is_null() {
        return Err(blocked("owner-unknown"));
    }
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4).is_err() {
        return Err(blocked("protection-unknown"));
    }
    let overlay = host["overlayWindowIds"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|id| id.as_i64() == Some(hwnd.0 as isize as i64));
    let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    // Layered per-pixel alpha and custom hit testing cannot be inferred from bounds.
    // Refuse ambiguous recipients rather than authorizing a window behind them.
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return Err(blocked("owner-unknown"));
    }
    let region = CreateRectRgn(0, 0, 0, 0);
    let region_kind = GetWindowRgn(hwnd, region);
    let in_region = region_kind == GDI_REGION_TYPE(0)
        || PtInRegion(region, point.x - rect.left, point.y - rect.top).as_bool();
    let _ = DeleteObject(HGDIOBJ(region.0));
    if !crate::safety::input_target_is_certain(
        IsWindowVisible(hwnd).as_bool(),
        IsIconic(hwnd).as_bool(),
        cloaked != 0,
        overlay,
        style & WS_EX_TRANSPARENT.0 != 0,
        style & WS_EX_LAYERED.0 != 0,
        in_region,
    ) {
        return Err(blocked("owner-unknown"));
    }
    let packed_point = ((point.y as u32 & 0xffff) << 16) | (point.x as u32 & 0xffff);
    for target in [recipient, hwnd] {
        let mut hit_result = 0usize;
        if SendMessageTimeoutW(
            target,
            WM_NCHITTEST,
            WPARAM(0),
            LPARAM(packed_point as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            50,
            Some(&mut hit_result),
        )
        .0 == 0
            || hit_result as isize == HTTRANSPARENT as isize
            || hit_result as isize == HTNOWHERE as isize
        {
            return Err(blocked("owner-unknown"));
        }
    }
    // Recheck the recipient after the synchronous hit test, immediately before authorization.
    if GetAncestor(WindowFromPoint(point), GA_ROOT) != hwnd {
        return Err(blocked("owner-unknown"));
    }
    authorize(hwnd, request, host, "click")?;
    if recipient != hwnd {
        authorize(recipient, request, host, "click")?;
    }
    Ok(())
}
pub(super) unsafe fn send(input: INPUT) -> Result<(), Value> {
    if SendInput(&[input], std::mem::size_of::<INPUT>() as i32) != 1 {
        return Err(blocked("elevated"));
    }
    mark_posted();
    Ok(())
}
pub(super) fn keyboard(code: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(code),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: MARK,
            },
        },
    }
}
pub(super) unsafe fn release() {
    let state = STATE.get().unwrap();
    let _gate = state.input_gate.lock().unwrap();
    let released = crate::safety::drain_held_inputs(
        &mut state.held.lock().unwrap(),
        &mut state.held_unicode.lock().unwrap(),
    );
    for input in released {
        match input {
            crate::safety::ReleasedInput::Unicode(unit) => {
                let _ = send(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(0),
                            wScan: unit,
                            dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: MARK,
                        },
                    },
                });
            }
            crate::safety::ReleasedInput::Key(code) => {
                let _ = send(keyboard(code, KEYEVENTF_KEYUP));
            }
            crate::safety::ReleasedInput::Button(code) => {
                let flags = if code == 0xff00 {
                    MOUSEEVENTF_LEFTUP
                } else if code == 0xff01 {
                    MOUSEEVENTF_RIGHTUP
                } else {
                    MOUSEEVENTF_MIDDLEUP
                };
                let _ = send(INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx: 0,
                            dy: 0,
                            mouseData: 0,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: MARK,
                        },
                    },
                });
            }
        }
    }
}
pub(super) fn suspend(event: Option<&str>) {
    let state = STATE.get().unwrap();
    state.emergency.store(true, Ordering::SeqCst);
    state.armed.store(false, Ordering::SeqCst);
    state.permit.lock().unwrap().suspend(None);
    for control in &state.controls {
        control.paused.store(true, Ordering::SeqCst);
    }
    unsafe { release() };
    if let Some(event) = event {
        emit(json!({"type":event,"recognizedAtMs":state.kill_recognized_ms.load(Ordering::SeqCst)}))
    }
}
pub(super) fn interrupt_from_hook(kill: bool) {
    let state = STATE.get().unwrap();
    state.input_sequence.fetch_add(1, Ordering::SeqCst);
    if kill {
        state.kill_recognized_ms.store(
            unsafe { windows::Win32::System::SystemInformation::GetTickCount64() },
            Ordering::SeqCst,
        );
    }
    // No mutex, allocation, stdout or SendInput on the hook thread.
    state.emergency.store(true, Ordering::SeqCst);
    state.armed.store(false, Ordering::SeqCst);
    state
        .pending_input
        .fetch_max(if kill { 2 } else { 1 }, Ordering::SeqCst);
}
/// Hook-safe: no locks, allocation, IPC or synthetic input. The atomic latch is
/// checked immediately before every dispatch; the reporting thread does cleanup.
pub(super) unsafe fn physical_input(window: HWND, pointer_move: bool, cause: u64) {
    let state = STATE.get().unwrap();
    state.input_sequence.fetch_add(1, Ordering::SeqCst);
    state.last_input_ms.store(
        state.started.elapsed().as_millis() as u64 + 1,
        Ordering::SeqCst,
    );
    let recipient_pid = pid(window) as u64;
    cooperation::physical(window.0 as u64, recipient_pid, pointer_move);
    for control in &state.controls {
        let generation = control.generation.load(Ordering::SeqCst);
        if generation == 0 || control.paused.load(Ordering::SeqCst) {
            continue;
        }
        let background = control.background.load(Ordering::SeqCst);
        let conflict = crate::safety::input_conflicts(
            background,
            pointer_move,
            control.window.load(Ordering::SeqCst),
            control.pid.load(Ordering::SeqCst),
            window.0 as u64,
            recipient_pid,
        ) || (background
            && !pointer_move
            && recipient_pid != 0
            && control.container_pid.load(Ordering::SeqCst) == recipient_pid);
        if conflict {
            control.recognized_ms.store(
                windows::Win32::System::SystemInformation::GetTickCount64(),
                Ordering::SeqCst,
            );
            control.paused.store(true, Ordering::SeqCst);
            control.input_cause.store(cause, Ordering::SeqCst);
            // Report the interrupted generation even if the slot is retired
            // and reused before the reporting thread runs.
            control.input_pending.store(generation, Ordering::SeqCst);
        }
    }
}
pub(super) unsafe extern "system" fn key_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let input = &*(l.0 as *const KBDLLHOOKSTRUCT);
        let state = STATE.get().unwrap();
        if input.dwExtraInfo == PROBE_MARK {
            state.keyboard_probe.store(
                state.started.elapsed().as_millis() as u64 + 1,
                Ordering::SeqCst,
            );
            return LRESULT(1); // Health probes never reach application message queues.
        } else if input.dwExtraInfo != MARK {
            if crate::safety::stop_chord(
                w.0 as u32,
                input.vkCode,
                GetAsyncKeyState(VK_CONTROL.0 as i32) < 0,
                GetAsyncKeyState(VK_MENU.0 as i32) < 0,
                GetAsyncKeyState(VK_SHIFT.0 as i32) < 0,
            ) {
                interrupt_from_hook(true)
            } else {
                physical_input(GetForegroundWindow(), false, 2);
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}
pub(super) unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let input = &*(l.0 as *const MSLLHOOKSTRUCT);
        if input.dwExtraInfo == PROBE_MARK {
            return LRESULT(1);
        } else if input.dwExtraInfo != MARK {
            let message = w.0 as u32;
            mouse_activity(
                input.pt,
                message == WM_MOUSEMOVE,
                if message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL {
                    3
                } else {
                    1
                },
            );
        }
    }
    CallNextHookEx(None, code, w, l)
}
pub(super) unsafe fn mouse_activity(point: POINT, pointer_move: bool, cause: u64) {
    let dragging = pointer_move
        && (GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0
            || GetAsyncKeyState(VK_RBUTTON.0 as i32) < 0
            || GetAsyncKeyState(VK_MBUTTON.0 as i32) < 0);
    if !pointer_move || dragging {
        physical_input(
            GetAncestor(WindowFromPoint(point), GA_ROOT),
            false,
            if dragging { 4 } else { cause },
        );
    } else {
        thread_local! {static LAST:std::cell::RefCell<(Instant,POINT)>=std::cell::RefCell::new((Instant::now(),POINT{x:0,y:0}));}
        LAST.with(|last| {
            let mut last = last.borrow_mut();
            if last.0.elapsed() > Duration::from_millis(250) {
                *last = (Instant::now(), point);
            } else if (f64::from(point.x) - f64::from(last.1.x))
                .hypot(f64::from(point.y) - f64::from(last.1.y))
                > 8.0
            {
                physical_input(GetAncestor(WindowFromPoint(point), GA_ROOT), true, 5);
            }
        })
    }
}
pub(super) unsafe fn mouse(
    point: POINT,
    flags: MOUSE_EVENT_FLAGS,
    data: u32,
    request: &Value,
    host: &Value,
) -> Result<(), Value> {
    hit(point, request, host)?;
    let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    let width = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2);
    let height = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2);
    let dx = ((point.x - left) as f64 * 65535.0 / (width - 1) as f64).round() as i32;
    let dy = ((point.y - top) as f64 * 65535.0 / (height - 1) as f64).round() as i32;
    let state = STATE.get().unwrap();
    let _gate = state.input_gate.lock().unwrap();
    if flags.contains(MOUSEEVENTF_LEFTDOWN) {
        state.held.lock().unwrap().insert(0xff00);
    }
    if flags.contains(MOUSEEVENTF_RIGHTDOWN) {
        state.held.lock().unwrap().insert(0xff01);
    }
    if flags.contains(MOUSEEVENTF_MIDDLEDOWN) {
        state.held.lock().unwrap().insert(0xff02);
    }
    check(request)?;
    send(INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE,
                time: 0,
                dwExtraInfo: MARK,
            },
        },
    })?;
    if flags.contains(MOUSEEVENTF_LEFTUP) {
        state.held.lock().unwrap().remove(&0xff00);
    }
    if flags.contains(MOUSEEVENTF_RIGHTUP) {
        state.held.lock().unwrap().remove(&0xff01);
    }
    if flags.contains(MOUSEEVENTF_MIDDLEUP) {
        state.held.lock().unwrap().remove(&0xff02);
    }
    Ok(())
}
pub(super) fn chord(raw: &str) -> Result<Vec<u16>, Value> {
    crate::safety::parse_chord(raw).map_err(|reason| {
        if reason == "system-ui" {
            blocked(reason)
        } else {
            fail(reason)
        }
    })
}
