//! Timing-only observer for the fixed F5 stop chord. Never injects input,
//! reads text, supplies consent or changes an event.
use std::{
    io::{BufRead, Write},
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        OnceLock,
    },
    time::Duration,
};
use windows::{
    core::w,
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{
            LibraryLoader::GetModuleHandleW, SystemInformation::GetTickCount64,
            Threading::GetCurrentThreadId,
        },
        UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};
static WINDOW: AtomicIsize = AtomicIsize::new(0);
static OVERFLOW: AtomicBool = AtomicBool::new(false);
static PROMPT: AtomicBool = AtomicBool::new(false);
static EVENTS: OnceLock<std::sync::mpsc::SyncSender<serde_json::Value>> = OnceLock::new();
const CALIBRATE: u32 = WM_APP + 10;
const GO: u32 = WM_APP + 11;
const FINISH: u32 = WM_APP + 12;
const CLOSE: u32 = WM_APP + 13;
fn emit(value: serde_json::Value) {
    if EVENTS
        .get()
        .is_some_and(|events| events.try_send(value).is_err())
    {
        OVERFLOW.store(true, Ordering::SeqCst);
    }
}
unsafe extern "system" fn keyboard(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && GetForegroundWindow().0 as isize == WINDOW.load(Ordering::SeqCst) {
        let event = &*(data.0 as *const KBDLLHOOKSTRUCT);
        if event.dwExtraInfo != 0xF5C1 {
            let now = GetTickCount64();
            let down = [WM_KEYDOWN, WM_SYSKEYDOWN].contains(&(message.0 as u32));
            let chord = event.dwExtraInfo != 0xF5C0
                && down
                && event.vkCode == VK_F12.0 as u32
                && GetAsyncKeyState(VK_CONTROL.0 as i32) < 0
                && GetAsyncKeyState(VK_MENU.0 as i32) < 0
                && GetAsyncKeyState(VK_SHIFT.0 as i32) < 0;
            let event_at = now.saturating_sub((now as u32).wrapping_sub(event.time) as u64);
            emit(
                serde_json::json!({"kind":if event.dwExtraInfo == 0xF5C0 {"injected"} else if chord {"chord"} else {"physical"},
                "eventAtMs":event_at,"observedAtMs":now,"keyDown":down}),
            );
        }
    }
    CallNextHookEx(None, code, message, data)
}
unsafe extern "system" fn procedure(hwnd: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match message {
        CALIBRATE => {
            emit(serde_json::json!({"kind":"calibration","observedAtMs":GetTickCount64()}));
            LRESULT(0)
        }
        GO => {
            PROMPT.store(true, Ordering::SeqCst);
            let _ = SetWindowTextW(hwnd, w!("Press Ctrl+Alt+Shift+F12 NOW"));
            let _ = InvalidateRect(Some(hwnd), None, true);
            emit(serde_json::json!({"kind":"prompt","observedAtMs":GetTickCount64()}));
            LRESULT(0)
        }
        FINISH => {
            emit(
                serde_json::json!({"kind":"finished","observedAtMs":GetTickCount64(),"frontmost":GetForegroundWindow() == hwnd}),
            );
            LRESULT(0)
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(hwnd, &mut paint);
            let brush = CreateSolidBrush(if PROMPT.load(Ordering::SeqCst) {
                COLORREF(0x000000ff)
            } else {
                COLORREF(0x00eeeeee)
            });
            FillRect(dc, &paint.rcPaint, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
            let _ = EndPaint(hwnd, &paint);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, wp, lp),
    }
}
pub fn run() -> windows::core::Result<()> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let (send, receive) = std::sync::mpsc::sync_channel(8192);
        let _ = EVENTS.set(send);
        std::thread::spawn(move || {
            for value in receive {
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{}", value);
                let _ = out.flush();
            }
        });
        let module = HINSTANCE(GetModuleHandleW(None)?.0);
        let class = w!("F5StopLatencyFixture");
        let registration = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: module,
            lpszClassName: class,
            hbrBackground: GetSysColorBrush(COLOR_WINDOW),
            ..Default::default()
        };
        if RegisterClassW(&registration) == 0 {
            return Err(windows::core::Error::from_thread());
        }
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("F5 physical stop check: wait for the prompt"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            660,
            240,
            None,
            None,
            Some(module),
            None,
        )?;
        WINDOW.store(hwnd.0 as isize, Ordering::SeqCst);
        let field = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("EDIT"),
            w!(""),
            WS_CHILD | WS_VISIBLE | WS_BORDER,
            30,
            80,
            590,
            40,
            Some(hwnd),
            None,
            Some(module),
            None,
        )?;
        let _hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), None, 0)?;
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(Some(field));
        let thread = GetCurrentThreadId();
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                let message = match line.as_str() {
                    "CALIBRATE" => CALIBRATE,
                    "GO" => GO,
                    "FINISH" => FINISH,
                    "COUNTDOWN_WAIT" => continue,
                    _ => CLOSE,
                };
                let _ = PostThreadMessageW(thread, message, WPARAM(0), LPARAM(0));
                if message == CLOSE {
                    return;
                }
            }
            let _ = PostThreadMessageW(thread, CLOSE, WPARAM(0), LPARAM(0));
        });
        println!("FIXTURE_READY");
        let mut message = MSG::default();
        loop {
            let result = GetMessageW(&mut message, None, 0, 0).0;
            if result <= 0 {
                break;
            }
            if OVERFLOW.swap(false, Ordering::SeqCst) {
                emit(serde_json::json!({"kind":"overflow","observedAtMs":GetTickCount64()}));
            }
            if message.hwnd.0.is_null() {
                if message.message == CLOSE {
                    DestroyWindow(hwnd)?;
                } else {
                    let _ = SendMessageW(
                        hwnd,
                        message.message,
                        Some(message.wParam),
                        Some(message.lParam),
                    );
                }
            } else {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        // Give the timing-only writer a bounded opportunity to flush its last receipt.
        std::thread::sleep(Duration::from_millis(20));
        Ok(())
    }
}
