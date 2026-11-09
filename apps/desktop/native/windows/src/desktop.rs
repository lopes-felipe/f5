mod capture;
use capture::*;
mod background;
mod background_events;
mod capture_worker;

mod accessibility;
use accessibility::*;

mod input;
use input::*;
mod mouse_monitor;

mod execution;
use execution::*;
mod cooperation;

mod identity;
use identity::*;

use crate::permits::{Permits, Scope};
use crate::safety::{app_tier, INPUT_MARK as MARK, PROBE_MARK};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{imageops, Rgba, RgbaImage};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{w, Interface, BOOL, BSTR, PCWSTR, PWSTR},
    Win32::{
        Foundation::*,
        Graphics::{Dwm::*, Gdi::*},
        Security::*,
        Storage::{Packaging::Appx::*, Xps::*},
        System::{Com::*, Ole::*, StationsAndDesktops::*, Threading::*},
        UI::{
            Accessibility::*, HiDpi::*, Input::KeyboardAndMouse::*, Shell::*,
            WindowsAndMessaging::*,
        },
    },
};
static STATE: OnceLock<Arc<State>> = OnceLock::new();
static OUTPUT: Mutex<()> = Mutex::new(());
static OUTPUT_QUEUE: OnceLock<std::sync::mpsc::SyncSender<Vec<u8>>> = OnceLock::new();
struct State {
    pending_settle: Mutex<Option<Instant>>,
    cancelled_requests: Mutex<std::collections::VecDeque<String>>,
    input_gate: Mutex<()>,
    permit: Mutex<Permits>,
    grants: Mutex<HashMap<String, Value>>,
    healthy: AtomicBool,
    keyboard_hook_installed: AtomicBool,
    foreground_hook_installed: AtomicBool,
    session_connected: AtomicBool,
    mouse_probe: AtomicU64,
    raw_mouse_window: AtomicU64,
    keyboard_probe: AtomicU64,
    armed: AtomicBool,
    emergency: AtomicBool,
    pending_input: AtomicU64,
    kill_recognized_ms: AtomicU64,
    hook_thread: AtomicU64,
    input_sequence: AtomicU64,
    last_input_ms: AtomicU64,
    controls: [GenerationControl; 128],
    watches: [cooperation::WatchSlot; 32],
    watch_owners: Mutex<HashMap<String, cooperation::Watch>>,
    background_actions: Mutex<HashMap<u64, cooperation::Action>>,
    in_flight: Mutex<HashMap<String, u64>>,
    generation_owners: Mutex<HashMap<u64, String>>,
    drains: AtomicU64,
    installed: Mutex<HashMap<String, String>>,
    started: Instant,
    held: Mutex<HashSet<u16>>,
    held_unicode: Mutex<HashSet<u16>>,
    snapshots: Mutex<HashMap<String, Vec<Snapshot>>>,
}
impl State {
    fn monitors_ready(&self) -> bool {
        self.healthy.load(Ordering::SeqCst)
            && self.keyboard_hook_installed.load(Ordering::SeqCst)
            && self.foreground_hook_installed.load(Ordering::SeqCst)
            && self.raw_mouse_window.load(Ordering::SeqCst) != 0
    }
}
#[derive(Clone)]
struct Snapshot {
    id: String,
    hwnd: isize,
    pid: u32,
    process_started: u64,
    authorization: Value,
    elements: HashMap<String, String>,
}
struct GenerationControl {
    generation: AtomicU64,
    window: AtomicU64,
    pid: AtomicU64,
    container_pid: AtomicU64,
    background: AtomicBool,
    paused: AtomicBool,
    input_pending: AtomicU64,
    input_cause: AtomicU64,
    recognized_ms: AtomicU64,
}
impl GenerationControl {
    fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            window: AtomicU64::new(0),
            pid: AtomicU64::new(0),
            container_pid: AtomicU64::new(0),
            background: AtomicBool::new(false),
            paused: AtomicBool::new(true),
            input_pending: AtomicU64::new(0),
            input_cause: AtomicU64::new(0),
            recognized_ms: AtomicU64::new(0),
        }
    }
}
fn emit(value: Value) {
    let Some(bytes) = crate::protocol::encode_packet(&value, 12 * 1024 * 1024) else {
        if let Some(state) = STATE.get() {
            state.permit.lock().unwrap().suspend(None);
        }
        return;
    };
    if let Some(queue) = OUTPUT_QUEUE.get() {
        if queue.try_send(bytes).is_err() {
            if let Some(state) = STATE.get() {
                state.permit.lock().unwrap().suspend(None);
            }
        }
        return;
    }
    write_packet(&bytes);
}
fn emit_status() {
    static LAST: Mutex<Option<Value>> = Mutex::new(None);
    let current = status();
    let mut previous = LAST.lock().unwrap();
    if previous.as_ref() == Some(&current) {
        return;
    }
    *previous = Some(current.clone());
    emit(json!({"type":"status","status":current}));
}
fn write_packet(bytes: &[u8]) {
    let _lock = OUTPUT.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(bytes);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
fn fail(tag: &str) -> Value {
    json!({"_tag":tag})
}
fn blocked(kind: &str) -> Value {
    json!({"_tag":"TargetBlocked","kind":kind})
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn n(v: &Value, key: &str) -> i32 {
    v[key].as_i64().unwrap_or(0) as i32
}
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

#[derive(Clone)]
struct Display {
    id: String,
    bounds: RECT,
    width: u32,
    height: u32,
    generation: String,
    rotation: u32,
    primary: bool,
}
impl Display {
    fn json(&self) -> Value {
        json!({"displayId":self.id,"geometryGeneration":self.generation,"primary":self.primary,"nativeBounds":{"x":self.bounds.left,"y":self.bounds.top,"width":self.bounds.right-self.bounds.left,"height":self.bounds.bottom-self.bounds.top},"pixelSize":{"width":self.bounds.right-self.bounds.left,"height":self.bounds.bottom-self.bounds.top},"modelSize":{"width":self.width,"height":self.height},"rotation":self.rotation})
    }
    fn point(&self, x: i32, y: i32) -> Result<POINT, Value> {
        if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
            return Err(fail("GeometryChanged"));
        }
        Ok(POINT {
            x: ((self.bounds.left as f64
                + (x as f64 + 0.5) * (self.bounds.right - self.bounds.left) as f64
                    / self.width as f64)
                .round() as i32)
                .min(self.bounds.right - 1),
            y: ((self.bounds.top as f64
                + (y as f64 + 0.5) * (self.bounds.bottom - self.bounds.top) as f64
                    / self.height as f64)
                .round() as i32)
                .min(self.bounds.bottom - 1),
        })
    }
}
unsafe extern "system" fn monitor_record(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(monitor, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
        let rect = info.monitorInfo.rcMonitor;
        let w = (rect.right - rect.left) as u32;
        let h = (rect.bottom - rect.top) as u32;
        let scale = 1f64
            .min(1456f64 / w.max(h) as f64)
            .min((1_150_000f64 / (w as f64 * h as f64)).sqrt());
        let id = String::from_utf16_lossy(&info.szDevice)
            .trim_end_matches('\0')
            .to_string();
        let mut mode = DEVMODEW::default();
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        let rotation = if EnumDisplaySettingsW(
            PCWSTR(info.szDevice.as_ptr()),
            ENUM_CURRENT_SETTINGS,
            &mut mode,
        )
        .as_bool()
        {
            mode.Anonymous1.Anonymous2.dmDisplayOrientation.0 * 90
        } else {
            0
        };
        let (mut dpi_x, mut dpi_y) = (96, 96);
        let _ = GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let generation = format!(
            "{}:{}:{}:{}:{}:{}:{}:{}",
            id, rect.left, rect.top, w, h, rotation, dpi_x, dpi_y
        );
        (*(data.0 as *mut Vec<Display>)).push(Display {
            id,
            bounds: rect,
            width: (w as f64 * scale).floor().max(1.0) as u32,
            height: (h as f64 * scale).floor().max(1.0) as u32,
            generation,
            rotation,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    BOOL(1)
}
unsafe fn displays() -> Vec<Display> {
    let mut list = Vec::new();
    let _ = EnumDisplayMonitors(
        None,
        None,
        Some(monitor_record),
        LPARAM(&mut list as *mut _ as isize),
    );
    list
}
unsafe fn select_display(request: &Value) -> Result<Display, Value> {
    let list = displays();
    let id = s(request, "displayId");
    list.iter()
        .find(|display| display.id == id || (id.is_empty() && list.len() == 1))
        .cloned()
        .ok_or(fail("GeometryChanged"))
}
unsafe extern "system" fn enum_window(hwnd: HWND, data: LPARAM) -> BOOL {
    (*(data.0 as *mut Vec<HWND>)).push(hwnd);
    BOOL(1)
}
unsafe fn windows() -> Vec<HWND> {
    let mut list = Vec::new();
    let _ = EnumWindows(Some(enum_window), LPARAM(&mut list as *mut _ as isize));
    list
}
unsafe fn execute(message: &Value) -> Result<Value, Value> {
    let request = &message["request"];
    let host = &message["hostAuthorization"];
    let op = s(request, "op");
    // Same metadata rule as foreground completion below. Applies across all helper queues.
    if !matches!(op, "status" | "listApps" | "resolveApps") {
        loop {
            let state = STATE.get().unwrap();
            let remaining = state
                .pending_settle
                .lock()
                .unwrap()
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_default();
            if remaining.is_zero() {
                break;
            }
            if state.emergency.load(Ordering::SeqCst)
                || state
                    .cancelled_requests
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|id| id == s(request, "requestId"))
            {
                return Err(json!({"_tag":"Interrupted","cause":"paused","actionStarted":false}));
            }
            if crate::timing::request_deadline_expired(
                request,
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            ) {
                return Err(
                    json!({"_tag":"Interrupted","cause":"permit-expired","actionStarted":false}),
                );
            }
            std::thread::sleep(remaining.min(Duration::from_millis(25)));
        }
    }
    match op {
        "status" => return Ok(status()),
        "listApps" => {
            let f5: HashSet<String> = windows()
                .into_iter()
                .filter_map(|hwnd| owner(hwnd).ok())
                .filter(|(_, pid)| {
                    host["f5Pids"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|entry| entry.as_u64() == Some(*pid as u64))
                })
                .map(|(id, _)| id)
                .collect();
            return Ok(json!(apps()
                .into_iter()
                .map(|mut app| {
                    if f5.contains(s(&app, "appId")) {
                        app["tier"] = json!("blocked");
                    }
                    app
                })
                .collect::<Vec<_>>()));
        }
        "resolveApps" => {
            let queries = request["queries"].as_array().ok_or(fail("Execution"))?;
            return Ok(json!(resolve_installed(host)
                .into_iter()
                .filter(|app| queries.iter().any(|query| {
                    let query = query.as_str().unwrap_or("").to_lowercase();
                    s(app, "appId") == query || s(app, "name").to_lowercase().contains(&query)
                }))
                .collect::<Vec<_>>()));
        }
        "inspect" => return inspect(request, host),
        "screenshot" | "zoom" => return capture(request, host),
        _ => {}
    }
    check(request)?;
    if s(request, "delivery") == "background" {
        return background::background_execute(request, host);
    }
    let mut verification = None;
    let outcome = (|| -> Result<(), Value> {
        if ["click", "move", "drag", "scroll"].contains(&op) {
            let display = select_display(request)?;
            if display.generation != s(request, "geometryGeneration") {
                return Err(fail("GeometryChanged"));
            }
            if op == "drag" {
                let from = &request["from"];
                let to = &request["to"];
                let a = display.point(n(from, "x"), n(from, "y"))?;
                let b = display.point(n(to, "x"), n(to, "y"))?;
                mouse(a, MOUSEEVENTF_LEFTDOWN, 0, request, host)?;
                for step in 1..=12 {
                    let p = POINT {
                        x: a.x + (b.x - a.x) * step / 12,
                        y: a.y + (b.y - a.y) * step / 12,
                    };
                    mouse(p, MOUSEEVENTF_MOVE, 0, request, host)?;
                    std::thread::sleep(Duration::from_millis(16));
                }
                mouse(b, MOUSEEVENTF_LEFTUP, 0, request, host)?;
            } else {
                let point = display.point(n(request, "x"), n(request, "y"))?;
                match op {
                    "move" => mouse(point, MOUSEEVENTF_MOVE, 0, request, host)?,
                    "click" => {
                        let (down, up) = match s(request, "button") {
                            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                            _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                        };
                        let modifiers: Vec<u16> = request["modifiers"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|modifier| match modifier.as_str().unwrap_or("") {
                                "Control" => VK_CONTROL.0,
                                "Alt" => VK_MENU.0,
                                "Shift" => VK_SHIFT.0,
                                "Meta" => VK_LWIN.0,
                                _ => 0,
                            })
                            .collect();
                        if modifiers.iter().any(|code| *code == 0) {
                            return Err(fail("UnsupportedAction"));
                        }
                        for code in &modifiers {
                            hit(point, request, host)?;
                            let target = GetAncestor(WindowFromPoint(point), GA_ROOT);
                            let front = GetForegroundWindow();
                            authorize(front, request, host, "click")?;
                            if owner(target)?.1 != owner(front)?.1 {
                                return Err(blocked("focus-unknown"));
                            }
                            let _gate = STATE.get().unwrap().input_gate.lock().unwrap();
                            STATE.get().unwrap().held.lock().unwrap().insert(*code);
                            check(request)?;
                            send(keyboard(*code, KEYBD_EVENT_FLAGS(0)))?;
                        }
                        for _ in 0..n(request, "clickCount").clamp(1, 3) {
                            mouse(point, down, 0, request, host)?;
                            mouse(point, up, 0, request, host)?;
                        }
                        for code in modifiers.iter().rev() {
                            hit(point, request, host)?;
                            let _gate = STATE.get().unwrap().input_gate.lock().unwrap();
                            check(request)?;
                            send(keyboard(*code, KEYEVENTF_KEYUP))?;
                            STATE.get().unwrap().held.lock().unwrap().remove(code);
                        }
                    }
                    "scroll" => {
                        for (key, flag) in [
                            ("deltaY", MOUSEEVENTF_WHEEL),
                            ("deltaX", MOUSEEVENTF_HWHEEL),
                        ] {
                            let delta = request[key].as_f64().unwrap_or(0.0).clamp(-50.0, 50.0)
                                * if key == "deltaY" { -1.0 } else { 1.0 };
                            if delta != 0.0 {
                                mouse(
                                    point,
                                    flag,
                                    (delta * 120.0).round() as i32 as u32,
                                    request,
                                    host,
                                )?;
                            }
                        }
                    }
                    _ => {}
                }
            }
        } else if op == "type" || op == "key" {
            let (initial_element, initial_pid, initial_hwnd) = focused(request, host)?;
            let initial_identity = if op == "type" {
                Some(runtime_id(&initial_element).map_err(|_| blocked("focus-unknown"))?)
            } else {
                None
            };
            let validate = || -> Result<(), Value> {
                check(request)?;
                let (element, p, h) = focused(request, host)?;
                if p != initial_pid || h != initial_hwnd {
                    return Err(blocked("focus-unknown"));
                }
                if let Some(identity) = &initial_identity {
                    if runtime_id(&element).map_err(|_| blocked("focus-unknown"))? != *identity {
                        return Err(blocked("focus-unknown"));
                    }
                }
                Ok(())
            };
            if op == "type" {
                let chars: Vec<char> = s(request, "text").chars().collect();
                if chars.len() > 10000 {
                    return Err(fail("ResultTooLarge"));
                }
                for chunk in chars.chunks(32) {
                    validate()?;
                    crate::safety::deliver_characters(
                        chunk.iter().copied(),
                        || validate(),
                        |character| {
                            let mut units = [0u16; 2];
                            for unit in character.encode_utf16(&mut units) {
                                for flags in
                                    [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP]
                                {
                                    check(request)?;
                                    let _gate = STATE.get().unwrap().input_gate.lock().unwrap();
                                    if !flags.contains(KEYEVENTF_KEYUP) {
                                        STATE
                                            .get()
                                            .unwrap()
                                            .held_unicode
                                            .lock()
                                            .unwrap()
                                            .insert(*unit);
                                    }
                                    check(request)?;
                                    // Secure-field/focus checks also precede every UTF-16 down event.
                                    if !flags.contains(KEYEVENTF_KEYUP) {
                                        validate()?;
                                    }
                                    if GetForegroundWindow() != initial_hwnd {
                                        return Err(blocked("focus-unknown"));
                                    }
                                    send(INPUT {
                                        r#type: INPUT_KEYBOARD,
                                        Anonymous: INPUT_0 {
                                            ki: KEYBDINPUT {
                                                wVk: VIRTUAL_KEY(0),
                                                wScan: *unit,
                                                dwFlags: flags,
                                                time: 0,
                                                dwExtraInfo: MARK,
                                            },
                                        },
                                    })?;
                                    if flags.contains(KEYEVENTF_KEYUP) {
                                        STATE
                                            .get()
                                            .unwrap()
                                            .held_unicode
                                            .lock()
                                            .unwrap()
                                            .remove(unit);
                                    }
                                }
                            }
                            Ok(())
                        },
                    )?;
                    std::thread::sleep(Duration::from_millis(10));
                }
            } else {
                let chords = request["chords"]
                    .as_array()
                    .ok_or(fail("UnsupportedAction"))?;
                if chords.is_empty() || chords.len() > 16 {
                    return Err(fail("UnsupportedAction"));
                }
                for _ in 0..n(request, "repeat").clamp(1, 20) {
                    for raw in chords {
                        let codes = chord(raw.as_str().unwrap_or(""))?;
                        if codes.contains(&VK_MENU.0)
                            && codes.contains(&VK_F4.0)
                            && host["f5Pids"]
                                .as_array()
                                .map(|pids| {
                                    pids.iter().any(|id| {
                                        id.as_u64() == Some(pid(GetForegroundWindow()) as u64)
                                    })
                                })
                                .unwrap_or(false)
                        {
                            return Err(blocked("f5"));
                        }
                        for code in &codes {
                            validate()?;
                            let _gate = STATE.get().unwrap().input_gate.lock().unwrap();
                            STATE.get().unwrap().held.lock().unwrap().insert(*code);
                            check(request)?;
                            send(keyboard(*code, KEYBD_EVENT_FLAGS(0)))?;
                        }
                        for code in codes.iter().rev() {
                            validate()?;
                            let _gate = STATE.get().unwrap().input_gate.lock().unwrap();
                            check(request)?;
                            send(keyboard(*code, KEYEVENTF_KEYUP))?;
                            STATE.get().unwrap().held.lock().unwrap().remove(code);
                        }
                    }
                }
            }
        } else if op == "elementAction" {
            verification = element_action(request, host)?;
        } else if op == "activateApp" {
            let hwnd = app_window(s(request, "appId"))?;
            authorize(hwnd, request, host, "click")?;
            check(request)?;
            mark_posted();
            if !SetForegroundWindow(hwnd).as_bool() {
                return Err(fail("Execution"));
            }
        } else if op == "openApp" {
            open_app(request, host)?;
        } else {
            return Err(fail("UnsupportedAction"));
        }
        Ok(())
    })();
    release();
    outcome?;
    confirm_action(request);
    let settle = crate::timing::post_action_settle_ms(
        op,
        request["screenshot"] == true,
        !s(request, "appId").is_empty(),
        displays().len(),
    );
    if settle > 0 {
        std::thread::sleep(Duration::from_millis(settle));
    }
    let list = displays();
    let mut pointer = POINT::default();
    let cursor_known = GetCursorPos(&mut pointer).is_ok();
    let cursor_display = if cursor_known {
        list.iter().find(|d| {
            pointer.x >= d.bounds.left
                && pointer.x < d.bounds.right
                && pointer.y >= d.bounds.top
                && pointer.y < d.bounds.bottom
        })
    } else {
        None
    };
    let requested_display = s(request, "displayId");
    let mut focused_bounds = RECT::default();
    let focused_bounds_known = GetWindowRect(GetForegroundWindow(), &mut focused_bounds).is_ok();
    let display_bounds: Vec<_> = list
        .iter()
        .map(|d| {
            (
                d.id.as_str(),
                (d.bounds.left, d.bounds.top, d.bounds.right, d.bounds.bottom),
            )
        })
        .collect();
    let result_display = crate::geometry::action_display_index(
        requested_display,
        focused_bounds_known.then_some((
            focused_bounds.left,
            focused_bounds.top,
            focused_bounds.right,
            focused_bounds.bottom,
        )),
        &display_bounds,
    )
    .and_then(|index| list.get(index));
    let mut result = json!({"displayId":result_display.map(|d|d.id.as_str()).unwrap_or("unknown"),"geometryGeneration":result_display.map(|d|d.generation.as_str()).unwrap_or("unknown"),"frontmostApp":app_record(GetForegroundWindow()).ok(),"cursor":cursor_display.map(|d| json!({"displayId":d.id,"x":(pointer.x-d.bounds.left) as f64*d.width as f64/(d.bounds.right-d.bounds.left) as f64,"y":(pointer.y-d.bounds.top) as f64*d.height as f64/(d.bounds.bottom-d.bounds.top) as f64}))});
    result["actionCompleted"] = json!(true);
    if let Some(verification) = verification {
        result["verification"] = verification;
    }
    if request["screenshot"] == true {
        let mut capture_request = request.clone();
        capture_request["op"] = json!("screenshot");
        if s(&capture_request, "displayId").is_empty() {
            if let Some(display) = result_display {
                capture_request["displayId"] = json!(display.id)
            }
        }
        match check(request).and_then(|_| capture_after_action(&capture_request, host)) {
            Ok(image) => result["screenshot"] = image,
            Err(error) => result["screenshotError"] = error["_tag"].clone(),
        }
    }
    if settle == 0 {
        *STATE.get().unwrap().pending_settle.lock().unwrap() =
            Some(Instant::now() + Duration::from_millis(300));
    }
    Ok(result)
}
fn status() -> Value {
    let state = STATE.get().unwrap();
    if let Err(error) = unsafe { interactive_desktop() } {
        json!({"available":false,"reason":"missing-permissions","detail":error["detail"].as_str().unwrap_or("Unlock Windows and return to the interactive desktop.")})
    } else if !state.monitors_ready() {
        json!({"available":false,"reason":"monitor-unhealthy"})
    } else {
        unsafe {
            json!({"available":true,"passwordMaskingSupported":true,"hostPlatform":"win32","stopShortcut":"Ctrl+Alt+Shift+F12","displays":displays().iter().map(Display::json).collect::<Vec<_>>()})
        }
    }
}
pub fn run() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--capture-window") {
        let result = args
            .get(2)
            .and_then(|raw| raw.parse::<usize>().ok())
            .ok_or(())
            .and_then(|window| unsafe {
                capture_worker::worker(HWND(window as *mut _)).map_err(|_| ())
            });
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let mutex_name = wide("Local\\F5ComputerControlV2");
        let mutex = CreateMutexW(None, true, PCWSTR(mutex_name.as_ptr()));
        if mutex.is_err() || GetLastError() == ERROR_ALREADY_EXISTS {
            emit(
                json!({"type":"hello","protocolVersion":1,"helperVersion":"2.0.0","startupFailure":{"available":false,"reason":"other-instance"}}),
            );
            emit(json!({"type":"status","status":{"available":false,"reason":"other-instance"}}));
            return;
        }
        let _device_lock = mutex.unwrap();
        if integrity(std::process::id()).unwrap_or(u32::MAX) > 0x2000 {
            emit(
                json!({"type":"hello","protocolVersion":1,"helperVersion":"2.0.0","startupFailure":{"available":false,"reason":"missing-permissions","detail":"Helper must run unelevated."}}),
            );
            emit(
                json!({"type":"status","status":{"available":false,"reason":"missing-permissions","detail":"Helper must run unelevated."}}),
            );
            return;
        }
    }
    let state = Arc::new(State {
        pending_settle: Mutex::new(None),
        cancelled_requests: Mutex::new(std::collections::VecDeque::new()),
        input_gate: Mutex::new(()),
        permit: Mutex::new(Permits::new()),
        grants: Mutex::new(HashMap::new()),
        healthy: AtomicBool::new(false),
        keyboard_hook_installed: AtomicBool::new(false),
        foreground_hook_installed: AtomicBool::new(false),
        session_connected: AtomicBool::new(unsafe { session_connected() }),
        mouse_probe: AtomicU64::new(0),
        raw_mouse_window: AtomicU64::new(0),
        keyboard_probe: AtomicU64::new(0),
        armed: AtomicBool::new(false),
        emergency: AtomicBool::new(true),
        pending_input: AtomicU64::new(0),
        kill_recognized_ms: AtomicU64::new(0),
        hook_thread: AtomicU64::new(0),
        input_sequence: AtomicU64::new(0),
        last_input_ms: AtomicU64::new(0),
        controls: std::array::from_fn(|_| GenerationControl::new()),
        watches: std::array::from_fn(|_| cooperation::WatchSlot::new()),
        watch_owners: Mutex::new(HashMap::new()),
        background_actions: Mutex::new(HashMap::new()),
        in_flight: Mutex::new(HashMap::new()),
        generation_owners: Mutex::new(HashMap::new()),
        drains: AtomicU64::new(0),
        installed: Mutex::new(HashMap::new()),
        started: Instant::now(),
        held: Mutex::new(HashSet::new()),
        held_unicode: Mutex::new(HashSet::new()),
        snapshots: Mutex::new(HashMap::new()),
    });
    let _ = STATE.set(state.clone());
    mouse_monitor::start();
    cooperation::start();
    // Hooks must never wait for stdout when Electron is stalled or disconnected.
    let (output_tx, output_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(32);
    let _ = OUTPUT_QUEUE.set(output_tx);
    std::thread::spawn(move || {
        for packet in output_rx {
            write_packet(&packet);
        }
    });
    std::thread::spawn(move || unsafe {
        let state = STATE.get().unwrap();
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        state
            .hook_thread
            .store(GetCurrentThreadId() as u64, Ordering::SeqCst);
        let mut keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), None, 0);
        let mut mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0);
        state
            .keyboard_hook_installed
            .store(keyboard.is_ok(), Ordering::SeqCst);
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            if message.message == WM_APP + 5 {
                state.healthy.store(false, Ordering::SeqCst);
                state.keyboard_hook_installed.store(false, Ordering::SeqCst);
                if let Ok(hook) = keyboard {
                    let _ = UnhookWindowsHookEx(hook);
                }
                if let Ok(hook) = mouse {
                    let _ = UnhookWindowsHookEx(hook);
                }
                keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), None, 0);
                mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0);
                state
                    .keyboard_hook_installed
                    .store(keyboard.is_ok(), Ordering::SeqCst);
            } else {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        state.healthy.store(false, Ordering::SeqCst);
        state.keyboard_hook_installed.store(false, Ordering::SeqCst);
        suspend(None);
    });
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(2));
        match STATE.get().unwrap().pending_input.swap(0, Ordering::SeqCst) {
            2 => suspend(Some("killSwitch")),
            1 => suspend(Some("physicalInput")),
            _ => {}
        }
        let state = STATE.get().unwrap();
        for slot in &state.controls {
            let generation = slot.input_pending.swap(0, Ordering::SeqCst);
            if generation != 0 {
                suspend_generation(Some(generation));
                emit(
                    json!({"type":"physicalInput","executionGeneration":generation,
                        "cause":match slot.input_cause.load(Ordering::SeqCst) {1=>"pointer",2=>"key",3=>"scroll",4=>"drag",5=>"move",_=>"unresolved"},
                        "recognizedAtMs":slot.recognized_ms.load(Ordering::SeqCst)}),
                );
            }
        }
    });
    emit(
        json!({"type":"hello","protocolVersion":1,"helperVersion":"2.1.0","capabilities":["background-ax-v1","computer-cooperation-v1","background-shared-app-v1","background-events-v1"]}),
    );
    std::thread::spawn(|| {
        let mut last_probe: Option<Instant> = None;
        let mut pending_probe: Option<(Instant, u64, u64, bool, bool)> = None;
        let mut probe_token = 0u64;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let state = STATE.get().unwrap();
            state
                .session_connected
                .store(unsafe { session_connected() }, Ordering::SeqCst);
            if unsafe { interactive_desktop() }.is_err() {
                suspend(None);
            }
            if let Some((at, sent, token, mouse_queued, keyboard_queued)) = pending_probe {
                let mouse_ack = state.mouse_probe.load(Ordering::SeqCst);
                let keyboard_ack = state.keyboard_probe.load(Ordering::SeqCst);
                let mouse_registered = unsafe { mouse_monitor::registered() };
                let acknowledged = crate::safety::input_monitors_healthy(
                    mouse_queued && mouse_registered,
                    mouse_ack == token,
                    keyboard_queued,
                    keyboard_ack,
                    sent,
                );
                if acknowledged
                    || !mouse_queued
                    || !keyboard_queued
                    || at.elapsed() >= Duration::from_millis(500)
                {
                    emit(json!({
                        "type":"hookProbe", "acknowledged":acknowledged,
                        "mouseProbe":"raw-input-liveness", "mouseRegistered":mouse_registered,
                        "mouseQueued":mouse_queued, "keyboardQueued":keyboard_queued,
                        "mouseAcknowledged":mouse_ack == token,
                        "keyboardAcknowledged":keyboard_ack >= sent,
                        "elapsedMs":at.elapsed().as_millis().min(10000) as u64
                    }));
                    pending_probe = None;
                    if acknowledged && state.keyboard_hook_installed.load(Ordering::SeqCst) {
                        // Installing hooks alone is not evidence they receive events.
                        // Recovery changes health only; suspended scopes stay suspended.
                        state.healthy.store(true, Ordering::SeqCst);
                    } else {
                        state.healthy.store(false, Ordering::SeqCst);
                        suspend(None);
                        let thread_id = state.hook_thread.load(Ordering::SeqCst) as u32;
                        unsafe {
                            let _ = PostThreadMessageW(thread_id, WM_APP + 5, WPARAM(0), LPARAM(0));
                        }
                    }
                }
            }
            loop {
                let expired = state.permit.lock().unwrap().take_expired_generation();
                let Some(generation) = expired else { break };
                suspend_generation(Some(generation));
                emit(json!({"type":"permitExpired","executionGeneration":generation}));
            }
            if !state.permit.lock().unwrap().active() {
                unsafe { release() }
            }
            // Probe while idle, before accepting the first action, as well as
            // during execution. Mouse monitoring uses a registered raw-input
            // receiver and a thread challenge, without synthetic mouse input.
            if !state.keyboard_hook_installed.load(Ordering::SeqCst)
                && last_probe.is_none_or(|at| at.elapsed() >= Duration::from_secs(2))
            {
                last_probe = Some(Instant::now());
                state.healthy.store(false, Ordering::SeqCst);
                suspend(None);
                let thread_id = state.hook_thread.load(Ordering::SeqCst) as u32;
                unsafe {
                    let _ = PostThreadMessageW(thread_id, WM_APP + 5, WPARAM(0), LPARAM(0));
                }
            }
            if pending_probe.is_none()
                && state.keyboard_hook_installed.load(Ordering::SeqCst)
                && last_probe.is_none_or(|at| at.elapsed() >= Duration::from_secs(2))
            {
                let at = Instant::now();
                let sent = state.started.elapsed().as_millis() as u64 + 1;
                probe_token += 1;
                let (mouse_queued, keyboard_queued) = unsafe {
                    let mouse_queued = mouse_monitor::probe(probe_token);
                    let mut probe = keyboard(VK_F24.0, KEYEVENTF_KEYUP);
                    probe.Anonymous.ki.dwExtraInfo = PROBE_MARK;
                    (mouse_queued, send(probe).is_ok())
                };
                pending_probe = Some((at, sent, probe_token, mouse_queued, keyboard_queued));
                last_probe = Some(at);
                if !mouse_queued || !keyboard_queued {
                    state.healthy.store(false, Ordering::SeqCst);
                    suspend(None);
                }
            }
            let active: Vec<_> = state
                .permit
                .lock()
                .unwrap()
                .scopes()
                .into_iter()
                .map(|(id, _)| id)
                .collect();
            let last = state.last_input_ms.load(Ordering::SeqCst);
            let age = if last == 0 {
                -1
            } else {
                (state.started.elapsed().as_millis() as u64 + 1).saturating_sub(last) as i64
            };
            emit(
                json!({"type":"heartbeat","monitorHealthy":state.monitors_ready(),"suspended":active.is_empty(),"activeGenerations":active,"inputSequence":state.input_sequence.load(Ordering::SeqCst),"lastUserInputAgeMs":age,"inputHeld":cooperation::held(),"targets":cooperation::target_summaries(),"frontmostAppId":unsafe { owner(GetForegroundWindow()).ok().map(|(id,_)|id) }}),
            );
            emit_status();
        }
    });
    let (input_tx, input_rx) = std::sync::mpsc::sync_channel::<Value>(32);
    std::thread::spawn(move || {
        for message in input_rx {
            respond(message)
        }
    });
    let background_queue = Arc::new(crate::scheduler::AppQueue::<Value>::new());
    for _ in 0..4 {
        let queue = background_queue.clone();
        std::thread::spawn(move || loop {
            let (app, message) = queue.take();
            respond(message);
            queue.finish(&app);
        });
    }
    let (observe_tx, observe_rx) = std::sync::mpsc::sync_channel::<Value>(4);
    let receiver = Arc::new(Mutex::new(observe_rx));
    for _ in 0..2 {
        let receiver = receiver.clone();
        std::thread::spawn(move || loop {
            let message = receiver.lock().unwrap().recv();
            match message {
                Ok(message) => respond(message),
                Err(_) => break,
            }
        });
    }
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    loop {
        let mut bytes = Vec::new();
        let Ok(count) = std::io::Read::by_ref(&mut reader)
            .take(12 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
        else {
            break;
        };
        if count == 0 || count > 12 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
            break;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        match s(&message, "type") {
            "watchRegister" | "availability" => {
                let result = if s(&message, "type") == "watchRegister" {
                    cooperation::register(s(&message, "appId"), s(&message, "owner"))
                } else {
                    cooperation::readiness(message["appId"].as_str())
                };
                match result {
                    Ok(result) => emit(
                        json!({"type":"response","requestId":message["requestId"],"result":result}),
                    ),
                    Err(error) => emit(
                        json!({"type":"response","requestId":message["requestId"],"error":error}),
                    ),
                }
            }
            "watchRelease" => {
                cooperation::release_watch(s(&message, "appId"), s(&message, "owner"))
            }
            "permit" => {
                let generation = message["executionGeneration"].as_u64().unwrap_or(0);
                let mut permits = state.permit.lock().unwrap();
                let scope = if message["scope"].is_null() {
                    if permits.scope(generation).is_some() {
                        None
                    } else {
                        Some(Scope::Foreground)
                    }
                } else {
                    Scope::decode(&message["scope"])
                };
                if !message["scope"].is_null() && scope.is_none() {
                    permits.suspend(Some(generation));
                } else {
                    permits.renew(
                        generation,
                        Duration::from_millis(message["expiresInMs"].as_u64().unwrap_or(0)),
                        scope,
                    );
                }
            }
            "resume" => {
                unsafe { resume_generation(&message) };
            }
            "suspend" => {
                suspend_generation(message["executionGeneration"].as_u64());
                if !s(&message, "requestId").is_empty() {
                    emit(json!({"type":"response","requestId":message["requestId"],"result":{}}))
                }
            }
            "cancel" => {
                let mut cancelled = state.cancelled_requests.lock().unwrap();
                cancelled.push_back(s(&message, "requestId").to_owned());
                if cancelled.len() > 4096 {
                    cancelled.pop_front();
                }
                drop(cancelled);
                state
                    .permit
                    .lock()
                    .unwrap()
                    .cancel(None, s(&message, "requestId"));
            }
            "retire" => {
                let generation = message["executionGeneration"].as_u64().unwrap_or(0);
                suspend_generation(Some(generation));
                state.permit.lock().unwrap().retire(generation);
                state.generation_owners.lock().unwrap().remove(&generation);
                if let Some(slot) = control(generation) {
                    slot.generation.store(0, Ordering::SeqCst);
                }
            }
            "readiness" => {
                let last = state.last_input_ms.load(Ordering::SeqCst);
                let age = if last == 0 {
                    -1
                } else {
                    (state.started.elapsed().as_millis() as u64 + 1).saturating_sub(last) as i64
                };
                emit(
                    json!({"type":"response","requestId":message["requestId"],"result":{"inputSequence":state.input_sequence.load(Ordering::SeqCst),"lastUserInputAgeMs":age}}),
                );
            }
            "drain" => {
                if state.drains.fetch_add(1, Ordering::SeqCst) >= 4 {
                    state.drains.fetch_sub(1, Ordering::SeqCst);
                    emit(
                        json!({"type":"response","requestId":message["requestId"],"result":{"drained":false}}),
                    );
                } else {
                    std::thread::spawn(move || {
                        let state = STATE.get().unwrap();
                        let generation = message["executionGeneration"].as_u64().unwrap_or(0);
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while state
                            .in_flight
                            .lock()
                            .unwrap()
                            .values()
                            .any(|id| *id == generation)
                            && Instant::now() < deadline
                        {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        let drained = !state
                            .in_flight
                            .lock()
                            .unwrap()
                            .values()
                            .any(|id| *id == generation);
                        emit(
                            json!({"type":"response","requestId":message["requestId"],"result":{"drained":drained}}),
                        );
                        state.drains.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            }
            "permissions" => emit_status(),
            "grantsChanged" => {
                let auth = message["authorization"].clone();
                state.grants.lock().unwrap().insert(auth_key(&auth), auth);
            }
            "request" => {
                let mut message = message;
                bind_observation_scope(&mut message);
                let op = s(&message["request"], "op");
                let mutation = ![
                    "status",
                    "listApps",
                    "resolveApps",
                    "inspect",
                    "screenshot",
                    "zoom",
                ]
                .contains(&op);
                let id = s(&message["request"], "requestId").to_owned();
                if mutation {
                    let mut in_flight = state.in_flight.lock().unwrap();
                    if in_flight.len() >= 96 || in_flight.contains_key(&id) {
                        emit(
                            json!({"type":"response","requestId":id,"error":{"_tag":"Busy","holder":"same-profile"}}),
                        );
                        continue;
                    }
                    in_flight.insert(id.clone(), generation(&message["request"]));
                }
                if mutation && s(&message["request"], "delivery") == "background" {
                    let app = s(&message["request"], "appId").to_owned();
                    if let Err(message) = background_queue.push(app, message) {
                        state.in_flight.lock().unwrap().remove(&id);
                        emit(
                            json!({"type":"response","requestId":message["request"]["requestId"],"error":{"_tag":"Busy","holder":"same-profile"}}),
                        );
                    }
                    continue;
                }
                let tx = if [
                    "status",
                    "listApps",
                    "resolveApps",
                    "inspect",
                    "screenshot",
                    "zoom",
                ]
                .contains(&op)
                {
                    &observe_tx
                } else {
                    &input_tx
                };
                if let Err(error) = tx.try_send(message) {
                    if mutation {
                        state.in_flight.lock().unwrap().remove(&id);
                    }
                    let message = match error {
                        std::sync::mpsc::TrySendError::Full(value)
                        | std::sync::mpsc::TrySendError::Disconnected(value) => value,
                    };
                    emit(
                        json!({"type":"response","requestId":message["request"]["requestId"],"error":{"_tag":"Busy","holder":"same-profile"}}),
                    )
                }
            }
            _ => break,
        }
    }
    suspend(None);
    std::process::exit(0);
}
fn respond(message: Value) {
    let id = message["request"]["requestId"].clone();
    reset_posted();
    let result = unsafe { execute(&message) }.map_err(|error| {
        let background = s(&message["request"], "delivery") == "background";
        if action_posted() && !background {
            *STATE.get().unwrap().pending_settle.lock().unwrap() =
                Some(Instant::now() + Duration::from_millis(300));
        }
        crate::protocol::action_response(error, action_posted(), background)
    });
    STATE
        .get()
        .unwrap()
        .in_flight
        .lock()
        .unwrap()
        .remove(id.as_str().unwrap_or(""));
    match result {
        Ok(value) => emit(json!({"type":"response","requestId":id,"result":value})),
        Err(error) => emit(json!({"type":"response","requestId":id,"error":error})),
    }
}
