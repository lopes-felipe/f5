use f5_computer_fixture::{Mode, Receipt, WindowCommand, SECURE_TEXT};
use std::cell::RefCell;
use std::io::{BufRead, Write};
use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Controls::EM_SETPASSWORDCHAR;
use windows::Win32::UI::HiDpi::*;
use windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, SetFocus, VK_PACKET};
use windows::Win32::UI::Input::*;
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const STATUS: u32 = WM_APP + 1;
const CLOSE_REQUEST: u32 = WM_APP + 2;
const CONTROL_REQUEST: u32 = WM_APP + 3;
const INPUT_ID: usize = 100;
const PRESS_ID: usize = 101;
const SECURE_ID: usize = 102;
const FINISH_ID: usize = 103;
const INSTRUCTION_ID: usize = 104;
struct State {
    instruction: HWND,
    delayed_button: Option<HWND>,
    changing_tick: u32,
    delayed_input: bool,
    tree: Vec<HWND>,
    mode: Mode,
    input: HWND,
    secure: HWND,
    receipt: Receipt,
}
thread_local! { static STATE: RefCell<Option<State>> = const { RefCell::new(None) }; }

fn emit(kind: &str, state: Option<serde_json::Value>) {
    let mut output = std::io::stdout().lock();
    let _ = writeln!(
        output,
        "{}",
        serde_json::json!({ "kind": kind, "state": state })
    );
    let _ = output.flush();
}
unsafe extern "system" fn monitor_receipt(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !GetMonitorInfoW(monitor, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
        return BOOL(0);
    }
    let mut mode = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    if !EnumDisplaySettingsW(
        PCWSTR(info.szDevice.as_ptr()),
        ENUM_CURRENT_SETTINGS,
        &mut mode,
    )
    .as_bool()
    {
        return BOOL(0);
    }
    let r = info.monitorInfo.rcMonitor;
    (*(data.0 as *mut Vec<serde_json::Value>)).push(serde_json::json!({
        "displayId":String::from_utf16_lossy(&info.szDevice).trim_end_matches('\0'),
        "bounds":{"x":r.left,"y":r.top,"width":r.right-r.left,"height":r.bottom-r.top},
        "rotation":mode.Anonymous1.Anonymous2.dmDisplayOrientation.0 * 90,
    }));
    BOOL(1)
}
unsafe fn observation(hwnd: HWND) -> windows::core::Result<()> {
    let mut bounds = RECT::default();
    GetWindowRect(hwnd, &mut bounds)?;
    let mut origin = POINT::default();
    if !ClientToScreen(hwnd, &mut origin).as_bool() {
        return Err(windows::core::Error::from_thread());
    }
    let mut displays: Vec<serde_json::Value> = Vec::new();
    if !EnumDisplayMonitors(
        None,
        None,
        Some(monitor_receipt),
        LPARAM(&mut displays as *mut _ as isize),
    )
    .as_bool()
    {
        return Err(windows::core::Error::from_thread());
    }
    STATE.with(|slot| {
        if let Some(state) = slot.borrow().as_ref() {
            let mut secure = RECT::default();
            let _ = GetWindowRect(state.secure, &mut secure);
            let rect = |r: RECT| serde_json::json!({"x":r.left,"y":r.top,"width":r.right-r.left,"height":r.bottom-r.top});
            emit("observation", Some(serde_json::json!({
                "pid":std::process::id(), "windowId":hwnd.0 as u64,
                "bounds":rect(bounds), "dpi":GetDpiForWindow(hwnd),
                "foregroundWindowId":GetForegroundWindow().0 as u64,
                "marker":{"x":origin.x+30,"y":origin.y+25,"width":400,"height":40},
                "secure":rect(secure), "receipt":state.receipt.summary(),
                "displays":displays,
            })));
        }
    });
    Ok(())
}
unsafe extern "system" fn procedure(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match message {
        WM_TIMER if w.0 == 2 => {
            let _ = KillTimer(Some(hwnd), 2);
            let created = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("BUTTON"),
                w!("Delayed ready"),
                WS_CHILD | WS_VISIBLE,
                30,
                190,
                180,
                22,
                Some(hwnd),
                Some(HMENU(PRESS_ID as *mut _)),
                None,
                None,
            );
            STATE.with(|slot| {
                if let Some(state) = slot.borrow_mut().as_mut() {
                    state.delayed_button = created.ok();
                }
            });
            println!("FIXTURE_DELAYED_READY");
            LRESULT(0)
        }
        WM_TIMER if w.0 == 3 => {
            let (instruction, tick) = STATE.with(|slot| {
                let mut state = slot.borrow_mut();
                let state = state.as_mut().unwrap();
                state.changing_tick += 1;
                (state.instruction, state.changing_tick)
            });
            let label = format!("Fixture change {tick}")
                .encode_utf16()
                .chain([0])
                .collect::<Vec<_>>();
            let _ = SetWindowTextW(instruction, PCWSTR(label.as_ptr()));
            if tick >= 10 {
                let _ = KillTimer(Some(hwnd), 3);
            }
            LRESULT(0)
        }
        WM_COMMAND => {
            let id = w.0 & 0xffff;
            let notification = (w.0 >> 16) & 0xffff;
            STATE.with(|slot| {
                if let Some(state) = slot.borrow_mut().as_mut() {
                    if id == PRESS_ID && notification == BN_CLICKED as usize {
                        state.receipt.press();
                        println!("FIXTURE_PRESSED");
                        emit("press", Some(state.receipt.summary()));
                    } else if [INPUT_ID, SECURE_ID].contains(&id)
                        && notification == EN_CHANGE as usize
                    {
                        let secure = id == SECURE_ID;
                        let control = if secure { state.secure } else { state.input };
                        let length = GetWindowTextLengthW(control).max(0) as usize;
                        if length > 10_000 {
                            state.receipt.overflow = true;
                        } else {
                            let mut buffer = vec![0u16; length + 1];
                            let read = GetWindowTextW(control, &mut buffer).max(0) as usize;
                            state.receipt.input(&buffer[..read.min(length)], secure);
                            if !secure && state.receipt.expected_text_received {
                                println!("FIXTURE_TYPED");
                            }
                            buffer.fill(0);
                        }
                        emit("input", Some(state.receipt.summary()));
                    }
                }
            });
            LRESULT(0)
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let mode = STATE.with(|slot| slot.borrow().as_ref().map(|state| state.mode));
            let color = if mode == Some(Mode::Ungranted) {
                COLORREF(0x0000ff00)
            } else {
                COLORREF(0x00ff0000)
            };
            let brush = CreateSolidBrush(color);
            FillRect(
                dc,
                &RECT {
                    left: 30,
                    top: 25,
                    right: 430,
                    bottom: 65,
                },
                brush,
            );
            let _ = DeleteObject(HGDIOBJ(brush.0));
            let _ = EndPaint(hwnd, &paint);
            LRESULT(0)
        }
        STATUS => {
            STATE.with(|slot| {
                if let Some(state) = slot.borrow().as_ref() {
                    emit("status", Some(state.receipt.summary()));
                }
            });
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, w, l),
    }
}

unsafe extern "system" fn finish_button(
    hwnd: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    if message == WM_LBUTTONUP {
        let mut source = INPUT_MESSAGE_SOURCE::default();
        if GetCurrentInputMessageSource(&mut source).is_ok() && source.originId == IMO_HARDWARE {
            println!("FIXTURE_ACKNOWLEDGED");
            let _ = EnableWindow(hwnd, false);
        }
    }
    DefSubclassProc(hwnd, message, w, l)
}
unsafe extern "system" fn delayed_input(
    hwnd: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    let delayed = STATE.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|state| state.delayed_input)
    });
    if delayed && (message == WM_SETFOCUS || (message == WM_KEYDOWN && w.0 != VK_PACKET.0 as usize))
    {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    if message == WM_KEYDOWN && w.0 == 13 {
        let verified = STATE.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(|state| state.receipt.expected_text_received)
        });
        if verified {
            println!("FIXTURE_ENTERED");
        }
    }
    DefSubclassProc(hwnd, message, w, l)
}
pub fn run(mode: Mode) -> windows::core::Result<()> {
    unsafe {
        // Coordinates and window geometry remain in physical pixels on each display.
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)?;
        let module = GetModuleHandleW(None)?;
        let instance = HINSTANCE(module.0);
        let class = w!("F5ComputerCertificationFixture");
        let registration = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW)?,
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            ..Default::default()
        };
        if RegisterClassW(&registration) == 0 {
            return Err(windows::core::Error::from_thread());
        }
        let extended = if mode == Mode::Transparent {
            WS_EX_LAYERED | WS_EX_TRANSPARENT
        } else {
            WINDOW_EX_STYLE(0)
        };
        let hwnd = CreateWindowExW(
            extended,
            class,
            w!("Computer Control Windows Fixture"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            600,
            400,
            None,
            None,
            Some(instance),
            None,
        )?;
        let control = |class: PCWSTR, label: PCWSTR, style: WINDOW_STYLE, y: i32, id: usize| {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                label,
                WS_CHILD | WS_VISIBLE | style,
                30,
                y,
                400,
                36,
                Some(hwnd),
                Some(HMENU(id as *mut _)),
                Some(instance),
                None,
            )
        };
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("Rehearsal input"),
            WS_CHILD | WS_VISIBLE,
            30,
            76,
            400,
            20,
            Some(hwnd),
            None,
            Some(instance),
            None,
        )?;
        let input = control(
            w!("EDIT"),
            w!(""),
            WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
            100,
            INPUT_ID,
        )?;
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("Rehearsal secure field"),
            WS_CHILD | WS_VISIBLE,
            30,
            136,
            400,
            20,
            Some(hwnd),
            None,
            Some(instance),
            None,
        )?;
        let secure = control(
            w!("EDIT"),
            w!(""),
            WS_BORDER | WINDOW_STYLE((ES_PASSWORD | ES_AUTOHSCROLL) as u32),
            160,
            SECURE_ID,
        )?;
        let password = SECURE_TEXT.encode_utf16().chain([0]).collect::<Vec<_>>();
        SetWindowTextW(secure, PCWSTR(password.as_ptr()))?;
        control(
            w!("BUTTON"),
            w!("Rehearsal press"),
            WINDOW_STYLE(BS_PUSHBUTTON as u32),
            220,
            PRESS_ID,
        )?;
        let finish = control(
            w!("BUTTON"),
            w!("Finish check"),
            WINDOW_STYLE(BS_PUSHBUTTON as u32),
            270,
            FINISH_ID,
        )?;
        if !SetWindowSubclass(finish, Some(finish_button), 1, 0).as_bool() {
            return Err(windows::core::Error::from_thread());
        }
        if !SetWindowSubclass(input, Some(delayed_input), 1, 0).as_bool() {
            return Err(windows::core::Error::from_thread());
        }
        let instruction = control(
            w!("STATIC"),
            w!("Ready: keep input idle"),
            WINDOW_STYLE(0),
            315,
            INSTRUCTION_ID,
        )?;
        STATE.with(|slot| {
            *slot.borrow_mut() = Some(State {
                mode,
                input,
                secure,
                receipt: Receipt::default(),
                instruction,
                delayed_button: None,
                changing_tick: 0,
                delayed_input: false,
                tree: Vec::new(),
            })
        });
        if mode == Mode::Transparent {
            SetLayeredWindowAttributes(hwnd, COLORREF(0), 128, LWA_ALPHA)?;
        }
        if mode == Mode::Shaped {
            let region = CreateEllipticRgn(0, 0, 600, 400);
            if region.0.is_null() || SetWindowRgn(hwnd, Some(region), true) == 0 {
                if !region.0.is_null() {
                    let _ = DeleteObject(HGDIOBJ(region.0));
                }
                return Err(windows::core::Error::from_thread());
            }
            // Successful SetWindowRgn transfers ownership to Windows.
        }
        let _ = ShowWindow(hwnd, SW_SHOW);
        println!("FIXTURE_READY");
        emit(
            "ready",
            Some(serde_json::json!({ "pid": std::process::id(), "protocolVersion": 1 })),
        );
        let gui_thread = GetCurrentThreadId();
        let (commands, pending_commands) = std::sync::mpsc::sync_channel(16);
        std::thread::spawn(move || {
            // Observation/control of this fixture only. No arbitrary HWND, file,
            // shell, helper message, consent answer or input API is accepted.
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else {
                    break;
                };
                let Some(command) = WindowCommand::parse(&line) else {
                    emit("invalid-command", None);
                    continue;
                };
                let closing = command == WindowCommand::Close;
                if commands.try_send(command).is_err() {
                    return;
                }
                // A window handle can be reused after closure. Only the fixture's
                // process-lifetime GUI thread receives stdin commands; it resolves
                // its own window on that thread before closing anything.
                if PostThreadMessageW(gui_thread, CONTROL_REQUEST, WPARAM(0), LPARAM(0)).is_err() {
                    return;
                }
                if closing {
                    return;
                }
            }
            let _ = PostThreadMessageW(gui_thread, CLOSE_REQUEST, WPARAM(0), LPARAM(0));
        });
        let mut restored = RECT::default();
        GetWindowRect(hwnd, &mut restored)?;
        let mut message = MSG::default();
        loop {
            let result = GetMessageW(&mut message, None, 0, 0).0;
            if result == -1 {
                return Err(windows::core::Error::from_thread());
            }
            if result == 0 {
                break;
            }
            if message.hwnd.0.is_null() {
                match message.message {
                    STATUS => {
                        STATE.with(|slot| {
                            if let Some(state) = slot.borrow().as_ref() {
                                emit("status", Some(state.receipt.summary()));
                            }
                        });
                    }
                    CLOSE_REQUEST => DestroyWindow(hwnd)?,
                    CONTROL_REQUEST => {
                        while let Ok(command) = pending_commands.try_recv() {
                            match command {
                                WindowCommand::Close => {
                                    DestroyWindow(hwnd)?;
                                    break;
                                }
                                WindowCommand::Status => {}
                                WindowCommand::Blur => {
                                    let _ = SetFocus(Some(hwnd));
                                    println!("FIXTURE_BLURRED");
                                }
                                WindowCommand::Reset => {
                                    SetWindowTextW(input, w!(""))?;
                                    SendMessageW(
                                        input,
                                        EM_SETPASSWORDCHAR,
                                        Some(WPARAM(0)),
                                        Some(LPARAM(0)),
                                    );
                                    let _ = KillTimer(Some(hwnd), 2);
                                    let _ = KillTimer(Some(hwnd), 3);
                                    let old = STATE.with(|slot| {
                                        slot.borrow_mut()
                                            .as_mut()
                                            .and_then(|state| state.delayed_button.take())
                                    });
                                    if let Some(old) = old {
                                        DestroyWindow(old)?;
                                    }
                                    SetWindowTextW(instruction, w!("Ready: keep input idle"))?;
                                    STATE.with(|slot| {
                                        if let Some(state) = slot.borrow_mut().as_mut() {
                                            state.receipt = Receipt::default();
                                        }
                                    });
                                    println!("FIXTURE_RESET");
                                }
                                WindowCommand::PerformanceTree { nodes } => {
                                    let old = STATE.with(|slot| {
                                        slot.borrow_mut()
                                            .as_mut()
                                            .map(|state| std::mem::take(&mut state.tree))
                                            .unwrap_or_default()
                                    });
                                    for child in old {
                                        let _ = DestroyWindow(child);
                                    }
                                    let mut tree = Vec::new();
                                    for index in 0..nodes {
                                        let label = format!("Fixture node {index}")
                                            .encode_utf16()
                                            .chain([0])
                                            .collect::<Vec<_>>();
                                        let edge = index == 0 || index == nodes - 1;
                                        let child = CreateWindowExW(
                                            WINDOW_EX_STYLE(0),
                                            if edge { w!("BUTTON") } else { w!("STATIC") },
                                            PCWSTR(label.as_ptr()),
                                            WS_CHILD | WS_VISIBLE,
                                            5 + (index % 20) as i32 * 24,
                                            30 + (index / 20) as i32 * 8,
                                            22,
                                            7,
                                            Some(hwnd),
                                            if edge {
                                                Some(HMENU(PRESS_ID as *mut _))
                                            } else {
                                                None
                                            },
                                            Some(instance),
                                            None,
                                        )?;
                                        tree.push(child);
                                    }
                                    STATE.with(|slot| {
                                        if let Some(state) = slot.borrow_mut().as_mut() {
                                            state.tree = tree;
                                        }
                                    });
                                    println!("FIXTURE_TREE_READY");
                                }
                                WindowCommand::DelayedInput => {
                                    STATE.with(|slot| {
                                        if let Some(state) = slot.borrow_mut().as_mut() {
                                            state.delayed_input = true;
                                        }
                                    });
                                    if !SetWindowSubclass(input, Some(delayed_input), 1, 0)
                                        .as_bool()
                                    {
                                        return Err(windows::core::Error::from_thread());
                                    }
                                    println!("FIXTURE_DELAYED_INPUT_READY");
                                }
                                WindowCommand::PasswordTransition => {
                                    // The driver sends this between cache construction and materialization.
                                    SendMessageW(
                                        input,
                                        EM_SETPASSWORDCHAR,
                                        Some(WPARAM(0x2022)),
                                        Some(LPARAM(0)),
                                    );
                                    println!("FIXTURE_PASSWORD_CHANGED");
                                }
                                WindowCommand::DelayButton => {
                                    SetTimer(Some(hwnd), 2, 1000, None);
                                    println!("FIXTURE_DELAY_SCHEDULED");
                                }
                                WindowCommand::Changing => {
                                    STATE.with(|slot| {
                                        if let Some(state) = slot.borrow_mut().as_mut() {
                                            state.changing_tick = 0;
                                        }
                                    });
                                    SetTimer(Some(hwnd), 3, 100, None);
                                    println!("FIXTURE_CHANGING_READY");
                                }
                                WindowCommand::Cue(text) => {
                                    let text = text.encode_utf16().chain([0]).collect::<Vec<_>>();
                                    SetWindowTextW(instruction, PCWSTR(text.as_ptr()))?;
                                }
                                WindowCommand::Place { x, y } => {
                                    SetWindowPos(
                                        hwnd,
                                        None,
                                        x,
                                        y,
                                        600,
                                        400,
                                        SWP_NOZORDER | SWP_NOACTIVATE,
                                    )?;
                                    GetWindowRect(hwnd, &mut restored)?;
                                }
                                WindowCommand::Fullscreen => {
                                    GetWindowRect(hwnd, &mut restored)?;
                                    let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                                    let mut info = MONITORINFO {
                                        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                                        ..Default::default()
                                    };
                                    if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                                        return Err(windows::core::Error::from_thread());
                                    }
                                    SetWindowLongW(
                                        hwnd,
                                        GWL_STYLE,
                                        (WS_POPUP | WS_VISIBLE).0 as i32,
                                    );
                                    SetWindowPos(
                                        hwnd,
                                        None,
                                        info.rcMonitor.left,
                                        info.rcMonitor.top,
                                        info.rcMonitor.right - info.rcMonitor.left,
                                        info.rcMonitor.bottom - info.rcMonitor.top,
                                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                                    )?;
                                }
                                WindowCommand::Restore => {
                                    SetWindowLongW(
                                        hwnd,
                                        GWL_STYLE,
                                        (WS_OVERLAPPEDWINDOW | WS_VISIBLE).0 as i32,
                                    );
                                    SetWindowPos(
                                        hwnd,
                                        None,
                                        restored.left,
                                        restored.top,
                                        600,
                                        400,
                                        SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                                    )?;
                                }
                                WindowCommand::ReplaceInput => {
                                    let previous =
                                        STATE.with(|slot| slot.borrow().as_ref().unwrap().input);
                                    // No RefCell borrow across synchronous window messages.
                                    // Create first to prevent immediate HWND/runtime-ID reuse.
                                    let replacement = control(
                                        w!("EDIT"),
                                        w!(""),
                                        WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                                        100,
                                        INPUT_ID,
                                    )?;
                                    DestroyWindow(previous)?;
                                    STATE.with(|slot| {
                                        slot.borrow_mut().as_mut().unwrap().input = replacement
                                    });
                                }
                            }
                            let _ = InvalidateRect(Some(hwnd), None, true);
                            let _ = UpdateWindow(hwnd);
                            observation(hwnd)?;
                        }
                    }
                    _ => {}
                }
                continue;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        STATE.with(|slot| {
            if let Some(state) = slot.borrow_mut().take() {
                emit("closed", Some(state.receipt.summary()));
            }
        });
        Ok(())
    }
}
