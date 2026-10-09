use crate::permit::Permit;
use crate::safety::app_tier;
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
        System::{Com::*, Ole::*, Threading::*},
        UI::{
            Accessibility::*, HiDpi::*, Input::KeyboardAndMouse::*, Shell::*,
            WindowsAndMessaging::*,
        },
    },
};
const MARK: usize = 0xF5C0;
const PROBE_MARK: usize = 0xF5C1;
static STATE: OnceLock<Arc<State>> = OnceLock::new();
static OUTPUT: Mutex<()> = Mutex::new(());
static OUTPUT_QUEUE: OnceLock<std::sync::mpsc::SyncSender<Vec<u8>>> = OnceLock::new();
struct State {
    input_gate: Mutex<()>,
    permit: Mutex<Permit>,
    grants: Mutex<HashMap<String, Value>>,
    healthy: AtomicBool,
    mouse_probe: AtomicU64,
    keyboard_probe: AtomicU64,
    armed: AtomicBool,
    emergency: AtomicBool,
    pending_input: AtomicU64,
    hook_thread: AtomicU64,
    installed: Mutex<HashMap<String, String>>,
    started: Instant,
    held: Mutex<HashSet<u16>>,
    held_unicode: Mutex<HashSet<u16>>,
    snapshots: Mutex<HashMap<String, Vec<Snapshot>>>,
}
#[derive(Clone)]
struct Snapshot {
    id: String,
    hwnd: isize,
    pid: u32,
    elements: HashMap<String, String>,
}
fn emit(value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    if bytes.len() > 12 * 1024 * 1024 {
        return;
    }
    if let Some(queue) = OUTPUT_QUEUE.get() {
        if queue.try_send(bytes).is_err() {
            if let Some(state) = STATE.get() {
                state.permit.lock().unwrap().suspend();
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

fn browser(id: &str) -> bool {
    let name = id.rsplit(['\\', '/']).next().unwrap_or(id);
    [
        "chrome.exe",
        "msedge.exe",
        "firefox.exe",
        "brave.exe",
        "opera.exe",
        "arc.exe",
    ]
    .contains(&name)
}
unsafe fn class(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut buffer);
    String::from_utf16_lossy(&buffer[..len.max(0) as usize]).to_lowercase()
}
unsafe fn pid(hwnd: HWND) -> u32 {
    let mut id = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut id));
    id
}
unsafe extern "system" fn child_owner(hwnd: HWND, data: LPARAM) -> BOOL {
    if class(hwnd) == "windows.ui.core.corewindow" {
        *(data.0 as *mut u32) = pid(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}
unsafe fn owner(hwnd: HWND) -> Result<(String, u32), Value> {
    let mut process_id = pid(hwnd);
    let mut process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
        .map_err(|_| blocked("owner-unknown"))?;
    let mut path = [0u16; 32768];
    let mut size = path.len() as u32;
    let path_ok = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(path.as_mut_ptr()),
        &mut size,
    )
    .is_ok();
    let _ = CloseHandle(process);
    if !path_ok {
        return Err(blocked("owner-unknown"));
    }
    let exe = String::from_utf16_lossy(&path[..size as usize]).to_lowercase();
    if exe.ends_with("\\applicationframehost.exe") {
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(child_owner),
            LPARAM(&mut process_id as *mut u32 as isize),
        );
        if process_id == pid(hwnd) {
            return Err(blocked("owner-unknown"));
        }
        process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .map_err(|_| blocked("owner-unknown"))?;
    } else {
        process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
            .map_err(|_| blocked("owner-unknown"))?;
    }
    let mut length = 0;
    let status = GetApplicationUserModelId(process, &mut length, None);
    let mut aumid = vec![0u16; length as usize];
    let id = if status == ERROR_INSUFFICIENT_BUFFER
        && length > 0
        && GetApplicationUserModelId(process, &mut length, Some(PWSTR(aumid.as_mut_ptr())))
            == ERROR_SUCCESS
    {
        String::from_utf16_lossy(&aumid[..length.saturating_sub(1) as usize]).to_lowercase()
    } else {
        exe
    };
    let _ = CloseHandle(process);
    Ok((id, process_id))
}
unsafe fn process_image(process_id: u32) -> Result<String, Value> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
        .map_err(|_| blocked("owner-unknown"))?;
    let mut path = [0u16; 32768];
    let mut size = path.len() as u32;
    let result = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        PWSTR(path.as_mut_ptr()),
        &mut size,
    );
    let _ = CloseHandle(process);
    result.map_err(|_| blocked("owner-unknown"))?;
    Ok(String::from_utf16_lossy(&path[..size as usize]).to_lowercase())
}
unsafe fn integrity(process_id: u32) -> Result<u32, Value> {
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)
        .map_err(|_| blocked("protection-unknown"))?;
    let mut token = HANDLE::default();
    let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
    let _ = CloseHandle(process);
    opened.map_err(|_| blocked("protection-unknown"))?;
    let mut needed = 0;
    let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut needed);
    let mut storage = vec![0usize; (needed as usize + 7) / 8];
    let status = GetTokenInformation(
        token,
        TokenIntegrityLevel,
        Some(storage.as_mut_ptr() as *mut _),
        needed,
        &mut needed,
    );
    if status.is_err() {
        let _ = CloseHandle(token);
        return Err(blocked("protection-unknown"));
    }
    let label = &*(storage.as_ptr() as *const TOKEN_MANDATORY_LABEL);
    let count = *GetSidSubAuthorityCount(label.Label.Sid);
    let level = *GetSidSubAuthority(label.Label.Sid, count.saturating_sub(1) as u32);
    let _ = CloseHandle(token);
    Ok(level)
}
fn auth_key(auth: &Value) -> String {
    format!("{}\0{}", s(auth, "profileId"), s(auth, "threadId"))
}
fn check_grants(request: &Value) -> Result<(), Value> {
    let auth = &request["authorization"];
    let state = STATE.get().unwrap();
    let grants = state.grants.lock().unwrap();
    let latest = grants
        .get(&auth_key(auth))
        .ok_or(json!({"_tag":"Interrupted","cause":"access-changed"}))?;
    if latest["sessionGeneration"] != auth["sessionGeneration"]
        || latest["grantVersion"] != auth["grantVersion"]
        || latest["grants"] != auth["grants"]
    {
        return Err(json!({"_tag":"Interrupted","cause":"access-changed"}));
    }
    Ok(())
}
fn check(request: &Value) -> Result<(), Value> {
    let state = STATE.get().unwrap();
    if state.emergency.load(Ordering::SeqCst) {
        return Err(json!({"_tag":"Interrupted","cause":"paused"}));
    }
    if !state.healthy.load(Ordering::SeqCst) {
        return Err(json!({"_tag":"Unavailable","reason":"monitor-unhealthy"}));
    }
    if !state.permit.lock().unwrap().valid(
        request["authorization"]["executionGeneration"]
            .as_u64()
            .unwrap_or(0),
        s(request, "requestId"),
    ) {
        return Err(json!({"_tag":"Interrupted","cause":"permit-expired"}));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    if now >= request["deadlineAtMs"].as_u64().unwrap_or(0) {
        return Err(json!({"_tag":"Interrupted","cause":"permit-expired"}));
    }
    check_grants(request)
}
unsafe fn authorize(
    hwnd: HWND,
    request: &Value,
    host: &Value,
    needed: &str,
) -> Result<String, Value> {
    let surface = class(hwnd);
    if [
        "shell_traywnd",
        "shell_secondarytraywnd",
        "progman",
        "workerw",
    ]
    .contains(&surface.as_str())
    {
        return Err(blocked("system-ui"));
    }
    let (id, process_id) = owner(hwnd)?;
    if host["f5Pids"]
        .as_array()
        .map(|pids| {
            pids.iter()
                .any(|pid| pid.as_u64() == Some(process_id as u64))
        })
        .unwrap_or(false)
    {
        return Err(blocked("f5"));
    }
    let executable = process_image(process_id)?;
    if crate::safety::system_process(&executable) {
        return Err(blocked("system-ui"));
    }
    if needed != "view" && integrity(process_id)? > integrity(std::process::id())? {
        return Err(blocked("elevated"));
    }
    let identity_tier = app_tier(&id);
    let executable_tier = app_tier(&executable);
    let tier = crate::safety::restrict_tier(&identity_tier, &executable_tier);
    if tier == "blocked" {
        return Err(blocked("protection-unknown"));
    }
    let grants = request["authorization"]["grants"]
        .as_array()
        .ok_or(blocked("protection-unknown"))?;
    let grant = grants
        .iter()
        .find(|grant| s(grant, "appId") == id && s(grant, "tier") == tier)
        .ok_or(json!({"_tag":"NotGranted","needed":needed}))?;
    if !crate::safety::grant_allows(tier, grant["allowTyping"] == true, needed) {
        return Err(json!({"_tag":"NotGranted","needed":needed}));
    }
    Ok(id)
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
unsafe fn hit(point: POINT, request: &Value, host: &Value) -> Result<(), Value> {
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
unsafe fn send(input: INPUT) -> Result<(), Value> {
    if SendInput(&[input], std::mem::size_of::<INPUT>() as i32) != 1 {
        return Err(blocked("elevated"));
    }
    Ok(())
}
fn keyboard(code: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
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
unsafe fn release() {
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
fn suspend(event: Option<&str>) {
    let state = STATE.get().unwrap();
    state.emergency.store(true, Ordering::SeqCst);
    state.armed.store(false, Ordering::SeqCst);
    state.permit.lock().unwrap().suspend();
    unsafe { release() };
    if let Some(event) = event {
        emit(json!({"type":event}))
    }
}
fn interrupt_from_hook(kill: bool) {
    let state = STATE.get().unwrap();
    // No mutex, allocation, stdout or SendInput on the hook thread.
    state.emergency.store(true, Ordering::SeqCst);
    state.armed.store(false, Ordering::SeqCst);
    state
        .pending_input
        .fetch_max(if kill { 2 } else { 1 }, Ordering::SeqCst);
}
unsafe extern "system" fn key_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let input = &*(l.0 as *const KBDLLHOOKSTRUCT);
        let state = STATE.get().unwrap();
        if input.dwExtraInfo == PROBE_MARK {
            state
                .keyboard_probe
                .store(state.started.elapsed().as_millis() as u64, Ordering::SeqCst);
            return LRESULT(1); // Health probes never reach application message queues.
        } else if input.dwExtraInfo != MARK {
            if w.0 as u32 == WM_KEYDOWN
                && input.vkCode == VK_F12.0 as u32
                && GetAsyncKeyState(VK_CONTROL.0 as i32) < 0
                && GetAsyncKeyState(VK_MENU.0 as i32) < 0
                && GetAsyncKeyState(VK_SHIFT.0 as i32) < 0
            {
                interrupt_from_hook(true)
            } else if state.armed.load(Ordering::SeqCst) {
                interrupt_from_hook(false)
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}
unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let input = &*(l.0 as *const MSLLHOOKSTRUCT);
        let state = STATE.get().unwrap();
        if input.dwExtraInfo == PROBE_MARK {
            state
                .mouse_probe
                .store(state.started.elapsed().as_millis() as u64, Ordering::SeqCst);
            return LRESULT(1);
        } else if input.dwExtraInfo != MARK && state.armed.load(Ordering::SeqCst) {
            if w.0 as u32 != WM_MOUSEMOVE {
                interrupt_from_hook(false)
            } else {
                thread_local! {static LAST:std::cell::RefCell<(Instant,POINT)>=std::cell::RefCell::new((Instant::now(),POINT{x:0,y:0}));}
                LAST.with(|last| {
                    let mut last = last.borrow_mut();
                    if last.0.elapsed() > Duration::from_millis(250) {
                        *last = (Instant::now(), input.pt);
                    } else if (input.pt.x - last.1.x).pow(2) + (input.pt.y - last.1.y).pow(2) > 64 {
                        interrupt_from_hook(false)
                    }
                })
            }
        }
    }
    CallNextHookEx(None, code, w, l)
}
unsafe fn automation() -> Result<IUIAutomation, Value> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        .map_err(|_| blocked("focus-unknown"))
}
unsafe fn focused(
    request: &Value,
    host: &Value,
) -> Result<(IUIAutomationElement, u32, HWND), Value> {
    let hwnd = GetForegroundWindow();
    authorize(hwnd, request, host, "type")?;
    let uia = automation()?;
    let element = uia
        .GetFocusedElement()
        .map_err(|_| blocked("focus-unknown"))?;
    let password = element
        .CurrentIsPassword()
        .ok()
        .map(|value| value.as_bool());
    let process_id = element.CurrentProcessId().ok().map(|value| value as u32);
    let (_, owner_id) = owner(hwnd)?;
    if let Some(kind) = crate::safety::focused_element_block(owner_id, process_id, password) {
        return Err(blocked(kind));
    }
    let process_id = process_id.ok_or(blocked("owner-unknown"))?;
    Ok((element, process_id, hwnd))
}
unsafe fn runtime_id(element: &IUIAutomationElement) -> Result<String, Value> {
    let array = element.GetRuntimeId().map_err(|_| fail("StaleElement"))?;
    let low = SafeArrayGetLBound(array, 1).map_err(|_| fail("StaleElement"))?;
    let high = SafeArrayGetUBound(array, 1).map_err(|_| fail("StaleElement"))?;
    let mut data = std::ptr::null_mut();
    SafeArrayAccessData(array, &mut data).map_err(|_| fail("StaleElement"))?;
    let values = std::slice::from_raw_parts(data as *const i32, (high - low + 1).max(0) as usize);
    let id = format!("{:?}", values);
    let _ = SafeArrayUnaccessData(array);
    let _ = SafeArrayDestroy(array);
    Ok(id)
}
unsafe fn walk(root: &IUIAutomationElement, max: usize) -> Vec<IUIAutomationElement> {
    walk_checked(root, max).0
}
unsafe fn walk_checked(
    root: &IUIAutomationElement,
    max: usize,
) -> (Vec<IUIAutomationElement>, bool) {
    let mut output = Vec::new();
    let Ok(uia) = automation() else {
        return (output, false);
    };
    let Ok(walker) = uia.ControlViewWalker() else {
        return (output, false);
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut complete = true;
    unsafe fn visit(
        walker: &IUIAutomationTreeWalker,
        node: IUIAutomationElement,
        depth: usize,
        max: usize,
        deadline: Instant,
        out: &mut Vec<IUIAutomationElement>,
        complete: &mut bool,
    ) {
        if depth > 30 || out.len() >= max || Instant::now() >= deadline {
            *complete = false;
            return;
        }
        out.push(node.clone());
        // UIA returns a null COM pointer when no child/sibling exists; other failures are incomplete.
        let mut child = walker.GetFirstChildElement(&node);
        while let Ok(element) = child {
            visit(
                walker,
                element.clone(),
                depth + 1,
                max,
                deadline,
                out,
                complete,
            );
            if !*complete {
                return;
            }
            child = walker.GetNextSiblingElement(&element);
        }
        if let Err(error) = child {
            if error.code() != windows::core::HRESULT(0x80004003u32 as i32) {
                *complete = false;
            }
        }
    }
    visit(
        &walker,
        root.clone(),
        0,
        max,
        deadline,
        &mut output,
        &mut complete,
    );
    (output, complete)
}
fn mask_rect(canvas: &mut RgbaImage, rect: RECT, display: &RECT) {
    let left = (rect.left - display.left).clamp(0, canvas.width() as i32) as u32;
    let top = (rect.top - display.top).clamp(0, canvas.height() as i32) as u32;
    let right = (rect.right - display.left).clamp(0, canvas.width() as i32) as u32;
    let bottom = (rect.bottom - display.top).clamp(0, canvas.height() as i32) as u32;
    for y in top..bottom {
        for x in left..right {
            canvas.put_pixel(x, y, Rgba([115, 115, 115, 255]));
        }
    }
}
unsafe fn app_window(id: &str) -> Result<HWND, Value> {
    windows()
        .into_iter()
        .find(|hwnd| owner(*hwnd).map(|(app, _)| app == id).unwrap_or(false))
        .ok_or(fail("StaleElement"))
}
unsafe fn inspect(request: &Value, host: &Value) -> Result<Value, Value> {
    check_grants(request)?;
    let app = s(request, "appId");
    let hwnd = app_window(app)?;
    authorize(hwnd, request, host, "view")?;
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    let Ok(uia) = automation() else {
        return Ok(json!({"snapshotId":snapshot_id,"appId":app,"accessible":false,"nodes":[]}));
    };
    let Ok(root) = uia.ElementFromHandle(hwnd) else {
        return Ok(json!({"snapshotId":snapshot_id,"appId":app,"accessible":false,"nodes":[]}));
    };
    let mut nodes = Vec::new();
    let mut elements = HashMap::new();
    for element in walk(&root, n(request, "maxNodes").clamp(1, 400) as usize) {
        let Ok(runtime) = runtime_id(&element) else {
            continue;
        };
        let reference = uuid::Uuid::new_v4().to_string();
        elements.insert(reference.clone(), runtime);
        let secure = element
            .CurrentIsPassword()
            .map(|value| value.as_bool())
            .unwrap_or(true);
        let mut actions = Vec::new();
        if !secure {
            if element
                .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .is_ok()
            {
                actions.push("press")
            }
            if element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .is_ok()
            {
                actions.push("setValue")
            }
            actions.push("focus");
            if element
                .GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
                .is_ok()
            {
                actions.extend(["increment", "decrement"])
            }
            if element
                .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
                .is_ok()
            {
                actions.push("scrollIntoView")
            }
        }
        let mut node = json!({"elementRef":reference,"role":element.CurrentLocalizedControlType().map(|value|value.to_string()).unwrap_or_default().chars().take(200).collect::<String>(),"name":if secure{String::new()}else{element.CurrentName().map(|value|value.to_string()).unwrap_or_default().chars().take(200).collect()},"focused":element.CurrentHasKeyboardFocus().map(|value|value.as_bool()).unwrap_or(false),"enabled":element.CurrentIsEnabled().map(|value|value.as_bool()).unwrap_or(false),"actions":actions});
        if !secure {
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            {
                if let Ok(value) = pattern.CurrentValue() {
                    node["value"] = json!(value.to_string().chars().take(200).collect::<String>());
                }
            }
        }
        if let Ok(rect) = element.CurrentBoundingRectangle() {
            for display in displays() {
                let x = ((rect.left - display.bounds.left) as f64 * display.width as f64
                    / (display.bounds.right - display.bounds.left) as f64)
                    .floor()
                    .max(0.0) as u32;
                let y = ((rect.top - display.bounds.top) as f64 * display.height as f64
                    / (display.bounds.bottom - display.bounds.top) as f64)
                    .floor()
                    .max(0.0) as u32;
                if rect.right > display.bounds.left
                    && rect.bottom > display.bounds.top
                    && rect.left < display.bounds.right
                    && rect.top < display.bounds.bottom
                    && x < display.width
                    && y < display.height
                {
                    node["displayId"] = json!(display.id);
                    node["bounds"] = json!({"x":x,"y":y,"width":(((rect.right-rect.left) as f64*display.width as f64/(display.bounds.right-display.bounds.left) as f64).ceil() as u32).clamp(1,display.width-x),"height":(((rect.bottom-rect.top) as f64*display.height as f64/(display.bounds.bottom-display.bounds.top) as f64).ceil() as u32).clamp(1,display.height-y)});
                    break;
                }
            }
        }
        nodes.push(node);
    }
    let snapshot = Snapshot {
        id: snapshot_id.clone(),
        hwnd: hwnd.0 as isize,
        pid: owner(hwnd)?.1,
        elements,
    };
    let state = STATE.get().unwrap();
    let mut cache = state.snapshots.lock().unwrap();
    let entries = cache.entry(app.to_string()).or_default();
    entries.push(snapshot);
    if entries.len() > 4 {
        entries.remove(0);
    }
    let value = json!({"snapshotId":snapshot_id,"appId":app,"accessible":true,"nodes":nodes});
    if serde_json::to_vec(&value).unwrap().len() > 256 * 1024 {
        return Err(fail("ResultTooLarge"));
    }
    Ok(value)
}
unsafe fn element_action(request: &Value, host: &Value) -> Result<(), Value> {
    check(request)?;
    let app = s(request, "appId");
    let hwnd = app_window(app)?;
    let action = s(request, "action");
    authorize(
        hwnd,
        request,
        host,
        if action == "setValue" {
            "type"
        } else {
            "click"
        },
    )?;
    let snapshot = STATE
        .get()
        .unwrap()
        .snapshots
        .lock()
        .unwrap()
        .get(app)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.id == s(request, "snapshotId"))
        })
        .cloned()
        .ok_or(fail("StaleElement"))?;
    if snapshot.hwnd != hwnd.0 as isize || snapshot.pid != owner(hwnd)?.1 {
        return Err(fail("StaleElement"));
    }
    let identity = snapshot
        .elements
        .get(s(request, "elementRef"))
        .ok_or(fail("StaleElement"))?;
    let uia = automation()?;
    let root = uia
        .ElementFromHandle(hwnd)
        .map_err(|_| fail("StaleElement"))?;
    let element = walk(&root, 400)
        .into_iter()
        .find(|element| {
            runtime_id(element)
                .map(|id| &id == identity)
                .unwrap_or(false)
        })
        .ok_or(fail("StaleElement"))?;
    if element
        .CurrentIsPassword()
        .map_err(|_| blocked("focus-unknown"))?
        .as_bool()
    {
        return Err(blocked("secure-field"));
    }
    if element
        .CurrentProcessId()
        .map_err(|_| fail("StaleElement"))? as u32
        != snapshot.pid
    {
        return Err(fail("StaleElement"));
    }
    check(request)?;
    let result = match action {
        "press" => element
            .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            .and_then(|pattern| pattern.Invoke()),
        "focus" => element.SetFocus(),
        "setValue" => element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|pattern| pattern.SetValue(&BSTR::from(s(request, "value")))),
        "scrollIntoView" => element
            .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)
            .and_then(|pattern| pattern.ScrollIntoView()),
        "increment" | "decrement" => element
            .GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
            .and_then(|pattern| {
                let current = pattern.CurrentValue()?;
                let step = pattern.CurrentSmallChange()?;
                pattern.SetValue(current + if action == "increment" { step } else { -step })
            }),
        _ => return Err(fail("UnsupportedAction")),
    };
    result.map_err(|_| fail("UnsupportedAction"))
}
unsafe fn mouse(
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
fn chord(raw: &str) -> Result<Vec<u16>, Value> {
    crate::safety::parse_chord(raw).map_err(|reason| {
        if reason == "system-ui" {
            blocked(reason)
        } else {
            fail(reason)
        }
    })
}

unsafe fn capture(request: &Value, host: &Value) -> Result<Value, Value> {
    check_grants(request)?;
    let target = select_display(request)?;
    let w = (target.bounds.right - target.bounds.left) as u32;
    let h = (target.bounds.bottom - target.bounds.top) as u32;
    if w > 16384 || h > 16384 {
        return Err(fail("ResultTooLarge"));
    }
    let mut canvas = RgbaImage::from_pixel(w, h, Rgba([115, 115, 115, 255]));
    let mut hidden = false;
    for hwnd in windows().into_iter().rev() {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            continue;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
        .is_err()
            || cloaked != 0
        {
            continue;
        }
        let mut rect = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_err()
        {
            continue;
        }
        if rect.right <= target.bounds.left
            || rect.bottom <= target.bounds.top
            || rect.left >= target.bounds.right
            || rect.top >= target.bounds.bottom
        {
            continue;
        }
        if authorize(hwnd, request, host, "view").is_err() {
            hidden = true;
            continue;
        }
        let mut capture_rect = RECT::default();
        if GetWindowRect(hwnd, &mut capture_rect).is_err() {
            continue;
        }
        let width = (capture_rect.right - capture_rect.left).max(0) as u32;
        let height = (capture_rect.bottom - capture_rect.top).max(0) as u32;
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            continue;
        }
        let dc = CreateCompatibleDC(None);
        if dc.0.is_null() {
            continue;
        }
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width as i32;
        info.bmiHeader.biHeight = -(height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;
        let mut bits = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let Ok(bitmap) = bitmap else {
            let _ = DeleteDC(dc);
            continue;
        };
        let old = SelectObject(dc, HGDIOBJ(bitmap.0));
        let success = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(2)).as_bool();
        if success && !bits.is_null() {
            let pixels =
                std::slice::from_raw_parts(bits as *const u8, width as usize * height as usize * 4);
            let bounds = |rect: RECT| crate::composition::CaptureRect {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
            };
            if !crate::composition::composite_window(
                &mut canvas,
                bounds(target.bounds),
                bounds(capture_rect),
                bounds(rect),
                pixels,
            ) {
                hidden = true;
            }
        }
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(dc);
    }
    let front = GetForegroundWindow();
    if authorize(front, request, host, "view").is_ok() {
        let mut incomplete;
        let tree = automation().and_then(|uia| {
            uia.ElementFromHandle(front)
                .map_err(|_| blocked("focus-unknown"))
        });
        if let Ok(root) = tree {
            let (elements, complete) = walk_checked(&root, 4000);
            incomplete = !complete;
            for element in elements {
                match element.CurrentIsPassword() {
                    Ok(password) if password.as_bool() => {
                        if let Ok(rect) = element.CurrentBoundingRectangle() {
                            mask_rect(&mut canvas, rect, &target.bounds);
                        } else {
                            incomplete = true;
                        }
                    }
                    Err(_) => incomplete = true,
                    _ => {}
                }
            }
        } else {
            incomplete = true;
        }
        if incomplete {
            hidden = true;
            let mut bounds = RECT::default();
            if GetWindowRect(front, &mut bounds).is_ok() {
                mask_rect(&mut canvas, bounds, &target.bounds);
            } else {
                canvas = RgbaImage::from_pixel(w, h, Rgba([115, 115, 115, 255]));
            }
        }
    }
    check_grants(request)?;
    if select_display(request)?.generation != target.generation {
        return Err(fail("GeometryChanged"));
    }
    let zoom = s(request, "op") == "zoom";
    let resized = if zoom {
        let rect = &request["rect"];
        let (x, y, width, height) = crate::geometry::zoom_bounds(
            (
                n(rect, "x").into(),
                n(rect, "y").into(),
                n(rect, "width").into(),
                n(rect, "height").into(),
            ),
            (target.width, target.height),
            (w, h),
        )
        .ok_or_else(|| fail("GeometryChanged"))?;
        let cropped = imageops::crop(&mut canvas, x, y, width, height).to_image();
        let scale = 1f64
            .min(1456f64 / width.max(height) as f64)
            .min((1_150_000f64 / (width as f64 * height as f64)).sqrt());
        imageops::resize(
            &cropped,
            ((width as f64 * scale).floor() as u32).max(1),
            ((height as f64 * scale).floor() as u32).max(1),
            imageops::FilterType::Triangle,
        )
    } else {
        imageops::resize(
            &canvas,
            target.width,
            target.height,
            imageops::FilterType::Triangle,
        )
    };
    let mut bytes = Vec::new();
    if zoom {
        image::DynamicImage::ImageRgba8(resized.clone())
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .map_err(|_| fail("Execution"))?;
    } else {
        let rgb = image::DynamicImage::ImageRgba8(resized.clone()).to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 75)
            .encode_image(&rgb)
            .map_err(|_| fail("Execution"))?;
    }
    let data = STANDARD.encode(bytes);
    if data.len() > 8 * 1024 * 1024 {
        return Err(fail("ResultTooLarge"));
    }
    let mut value = json!({"displayId":target.id,"geometryGeneration":target.generation,"modelSize":{"width":resized.width(),"height":resized.height()},"mimeType":if zoom{"image/png"}else{"image/jpeg"},"data":data,"hiddenContent":hidden});
    if zoom {
        value["rect"] = request["rect"].clone()
    }
    Ok(value)
}
unsafe fn apps() -> Vec<Value> {
    let mut unique = HashMap::new();
    for hwnd in windows() {
        if !IsWindowVisible(hwnd).as_bool() {
            continue;
        }
        if let Ok((id, process_id)) = owner(hwnd) {
            let identity_tier = app_tier(&id);
            let executable = process_image(process_id);
            let executable_tier = executable
                .as_ref()
                .map(|exe| app_tier(exe))
                .unwrap_or_else(|_| "blocked".into());
            let tier = crate::safety::restrict_tier(&identity_tier, &executable_tier);
            let name = id.rsplit(['\\', '/']).next().unwrap_or(&id).to_string();
            unique.entry(id.clone()).or_insert(json!({"appId":id,"name":name,"running":true,"frontmost":hwnd==GetForegroundWindow(),"tier":tier,"warning":if browser(&id) || executable.as_ref().map(|exe|browser(exe)).unwrap_or(false){json!("browser")}else{Value::Null}}));
        }
    }
    unique
        .into_values()
        .map(|mut value| {
            if value["warning"].is_null() {
                value.as_object_mut().unwrap().remove("warning");
            }
            value
        })
        .collect()
}
unsafe fn resolve_installed(host: &Value) -> Vec<Value> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let mut records: HashMap<String, Value> = apps()
        .into_iter()
        .map(|app| (s(&app, "appId").to_string(), app))
        .collect();
    let mut paths = Vec::new();
    fn links(dir: &std::path::Path, depth: usize, output: &mut Vec<std::path::PathBuf>) {
        if depth > 8 || output.len() >= 5000 {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    links(&path, depth + 1, output);
                } else if path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("lnk"))
                    .unwrap_or(false)
                {
                    output.push(path);
                }
            }
        }
    }
    for env in ["ProgramData", "AppData"] {
        if let Ok(root) = std::env::var(env) {
            links(
                &std::path::Path::new(&root).join("Microsoft/Windows/Start Menu/Programs"),
                0,
                &mut paths,
            );
        }
    }
    for path in paths {
        let Ok(link) = CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER)
        else {
            continue;
        };
        let Ok(file) = link.cast::<IPersistFile>() else {
            continue;
        };
        let path_wide = wide(&path.to_string_lossy());
        if file.Load(PCWSTR(path_wide.as_ptr()), STGM_READ).is_err() {
            continue;
        }
        let mut target = [0u16; 32768];
        if link
            .GetPath(&mut target, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32)
            .is_err()
        {
            continue;
        }
        let end = target
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(target.len());
        let target = String::from_utf16_lossy(&target[..end]);
        if !std::path::Path::new(&target).is_absolute() || !target.to_lowercase().ends_with(".exe")
        {
            continue;
        }
        let id = target.to_lowercase();
        STATE
            .get()
            .unwrap()
            .installed
            .lock()
            .unwrap()
            .insert(id.clone(), target);
        records.entry(id.clone()).or_insert(json!({"appId":id,"name":path.file_stem().unwrap_or_default().to_string_lossy(),"running":false,"frontmost":false,"tier":app_tier(&id)}));
    }
    let folder_name = wide("shell:AppsFolder");
    if let Ok(folder) =
        SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(folder_name.as_ptr()), None)
    {
        if let Ok(items) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) {
            for _ in 0..5000 {
                let mut item = [None];
                let mut fetched = 0;
                if items.Next(&mut item, Some(&mut fetched)).is_err() || fetched == 0 {
                    break;
                }
                let Some(item) = item[0].take() else { break };
                if let Ok(raw) = item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) {
                    let id = raw.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(raw.0 as _));
                    let id = id.rsplit('\\').next().unwrap_or(&id).to_string();
                    if !id.contains('!') {
                        continue;
                    }
                    let name = item
                        .GetDisplayName(SIGDN_NORMALDISPLAY)
                        .map(|raw| {
                            let value = raw.to_string().unwrap_or_default();
                            CoTaskMemFree(Some(raw.0 as _));
                            value
                        })
                        .unwrap_or_else(|_| id.clone());
                    STATE
                        .get()
                        .unwrap()
                        .installed
                        .lock()
                        .unwrap()
                        .insert(id.to_lowercase(), id.clone());
                    let id = id.to_lowercase();
                    records.entry(id.clone()).or_insert(json!({"appId":id,"name":name,"running":false,"frontmost":false,"tier":app_tier(&id)}));
                }
            }
        }
    }
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
    records
        .into_values()
        .map(|mut record| {
            if f5.contains(s(&record, "appId")) {
                record["tier"] = json!("blocked");
            }
            if browser(s(&record, "appId")) {
                record["warning"] = json!("browser");
            }
            record
        })
        .collect()
}
unsafe fn open_app(request: &Value, host: &Value) -> Result<(), Value> {
    check(request)?;
    let id = s(request, "appId");
    let tier = app_tier(id);
    if tier == "blocked" {
        return Err(blocked("protection-unknown"));
    }
    let granted = request["authorization"]["grants"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|grant| {
            s(grant, "appId") == id
                && s(grant, "tier") == tier
                && ["click", "full"].contains(&tier.as_str())
        });
    if !granted {
        return Err(json!({"_tag":"NotGranted","needed":"click"}));
    }
    resolve_installed(host);
    let target = STATE
        .get()
        .unwrap()
        .installed
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or(fail("UnsupportedAction"))?;
    let f5_path = s(host, "f5BundlePath").to_lowercase();
    if !f5_path.is_empty() && target.to_lowercase().starts_with(&f5_path) {
        return Err(blocked("f5"));
    }
    check(request)?;
    let name = wide(&target);
    if target.contains('!') {
        let manager: IApplicationActivationManager =
            CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)
                .map_err(|_| fail("UnsupportedAction"))?;
        manager
            .ActivateApplication(PCWSTR(name.as_ptr()), PCWSTR::null(), AO_NONE)
            .map_err(|_| fail("Execution"))?;
    } else if ShellExecuteW(
        None,
        w!("open"),
        PCWSTR(name.as_ptr()),
        PCWSTR::null(),
        PCWSTR::null(),
        SW_SHOWNORMAL,
    )
    .0 as usize
        <= 32
    {
        return Err(fail("Execution"));
    }
    Ok(())
}
unsafe fn execute(message: &Value) -> Result<Value, Value> {
    let request = &message["request"];
    let host = &message["hostAuthorization"];
    let op = s(request, "op");
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
                    for character in chunk {
                        let mut units = [0u16; 2];
                        for unit in character.encode_utf16(&mut units) {
                            for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
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
                                // Cheap per-event ownership guard; expensive UIA focus/security checks
                                // remain at Unicode-safe chunk boundaries.
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
                    }
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
            element_action(request, host)?;
        } else if op == "activateApp" {
            let hwnd = app_window(s(request, "appId"))?;
            authorize(hwnd, request, host, "click")?;
            check(request)?;
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
    std::thread::sleep(Duration::from_millis(300));
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
    let result_display = list
        .iter()
        .find(|d| d.id == s(request, "displayId"))
        .or(cursor_display)
        .or(list.first());
    let mut result = json!({"displayId":result_display.map(|d|d.id.as_str()).unwrap_or("unknown"),"geometryGeneration":result_display.map(|d|d.generation.as_str()).unwrap_or("unknown"),"frontmostApp":apps().into_iter().find(|app|app["frontmost"]==true),"cursor":cursor_display.map(|d| json!({"displayId":d.id,"x":(pointer.x-d.bounds.left) as f64*d.width as f64/(d.bounds.right-d.bounds.left) as f64,"y":(pointer.y-d.bounds.top) as f64*d.height as f64/(d.bounds.bottom-d.bounds.top) as f64}))});
    result["actionCompleted"] = json!(true);
    if request["screenshot"] == true {
        let mut capture_request = request.clone();
        capture_request["op"] = json!("screenshot");
        if s(&capture_request, "displayId").is_empty() {
            let list = displays();
            let hwnd = GetForegroundWindow();
            let mut bounds = RECT::default();
            let _ = GetWindowRect(hwnd, &mut bounds);
            if let Some(display) = list.iter().find(|d| {
                bounds.left >= d.bounds.left
                    && bounds.left < d.bounds.right
                    && bounds.top >= d.bounds.top
                    && bounds.top < d.bounds.bottom
            }) {
                capture_request["displayId"] = json!(display.id)
            }
        }
        match check(request).and_then(|_| capture(&capture_request, host)) {
            Ok(image) => result["screenshot"] = image,
            Err(error) => result["screenshotError"] = error["_tag"].clone(),
        }
    }
    Ok(result)
}
fn status() -> Value {
    let state = STATE.get().unwrap();
    if !state.healthy.load(Ordering::SeqCst) {
        json!({"available":false,"reason":"monitor-unhealthy"})
    } else {
        unsafe {
            json!({"available":true,"displays":displays().iter().map(Display::json).collect::<Vec<_>>()})
        }
    }
}
pub fn run() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let mutex_name = wide("Local\\F5ComputerControlV2");
        let mutex = CreateMutexW(None, true, PCWSTR(mutex_name.as_ptr()));
        if mutex.is_err() || GetLastError() == ERROR_ALREADY_EXISTS {
            emit(json!({"type":"hello","protocolVersion":1,"helperVersion":"2.0.0"}));
            emit(json!({"type":"status","status":{"available":false,"reason":"other-instance"}}));
            return;
        }
        let _device_lock = mutex.unwrap();
        if integrity(std::process::id()).unwrap_or(u32::MAX) > 0x2000 {
            emit(json!({"type":"hello","protocolVersion":1,"helperVersion":"2.0.0"}));
            emit(
                json!({"type":"status","status":{"available":false,"reason":"missing-permissions","detail":"Helper must run unelevated."}}),
            );
            return;
        }
    }
    let state = Arc::new(State {
        input_gate: Mutex::new(()),
        permit: Mutex::new(Permit::new()),
        grants: Mutex::new(HashMap::new()),
        healthy: AtomicBool::new(false),
        mouse_probe: AtomicU64::new(0),
        keyboard_probe: AtomicU64::new(0),
        armed: AtomicBool::new(false),
        emergency: AtomicBool::new(true),
        pending_input: AtomicU64::new(0),
        hook_thread: AtomicU64::new(0),
        installed: Mutex::new(HashMap::new()),
        started: Instant::now(),
        held: Mutex::new(HashSet::new()),
        held_unicode: Mutex::new(HashSet::new()),
        snapshots: Mutex::new(HashMap::new()),
    });
    let _ = STATE.set(state.clone());
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
            .healthy
            .store(keyboard.is_ok() && mouse.is_ok(), Ordering::SeqCst);
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            if message.message == WM_APP + 5 {
                if let Ok(hook) = keyboard {
                    let _ = UnhookWindowsHookEx(hook);
                }
                if let Ok(hook) = mouse {
                    let _ = UnhookWindowsHookEx(hook);
                }
                keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), None, 0);
                mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0);
                state
                    .healthy
                    .store(keyboard.is_ok() && mouse.is_ok(), Ordering::SeqCst);
            } else {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        state.healthy.store(false, Ordering::SeqCst);
        suspend(None);
    });
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(2));
        match STATE.get().unwrap().pending_input.swap(0, Ordering::SeqCst) {
            2 => suspend(Some("killSwitch")),
            1 => suspend(Some("physicalInput")),
            _ => {}
        }
    });
    emit(json!({"type":"hello","protocolVersion":1,"helperVersion":"2.0.0"}));
    std::thread::spawn(|| {
        let mut probe_due = Instant::now();
        let mut pending_probe: Option<(Instant, u64)> = None;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let state = STATE.get().unwrap();
            if let Some((at, sent)) = pending_probe {
                if crate::safety::hooks_healthy(
                    state.mouse_probe.load(Ordering::SeqCst),
                    state.keyboard_probe.load(Ordering::SeqCst),
                    sent,
                ) {
                    pending_probe = None;
                } else if at.elapsed() >= Duration::from_millis(500) {
                    state.healthy.store(false, Ordering::SeqCst);
                    suspend(None);
                    let thread_id = state.hook_thread.load(Ordering::SeqCst) as u32;
                    unsafe {
                        let _ = PostThreadMessageW(thread_id, WM_APP + 5, WPARAM(0), LPARAM(0));
                    }
                    pending_probe = None;
                }
            }
            let expired = state.permit.lock().unwrap().take_expired_generation();
            if let Some(generation) = expired {
                unsafe { release() }
                emit(json!({"type":"permitExpired","executionGeneration":generation}));
            }
            if !state.permit.lock().unwrap().active() {
                unsafe { release() }
            } else if pending_probe.is_none() && probe_due.elapsed() >= Duration::from_secs(2) {
                let sent = state.started.elapsed().as_millis() as u64;
                unsafe {
                    let _ = send(INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: 0,
                                dy: 0,
                                mouseData: 0,
                                dwFlags: MOUSEEVENTF_MOVE,
                                time: 0,
                                dwExtraInfo: PROBE_MARK,
                            },
                        },
                    });
                    let mut probe = keyboard(VK_F24.0, KEYEVENTF_KEYUP);
                    probe.Anonymous.ki.dwExtraInfo = PROBE_MARK;
                    let _ = send(probe);
                }
                pending_probe = Some((Instant::now(), sent));
                probe_due = Instant::now();
            }
            emit(
                json!({"type":"heartbeat","monitorHealthy":state.healthy.load(Ordering::SeqCst),"suspended":!state.permit.lock().unwrap().active()}),
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
            "permit" => state.permit.lock().unwrap().renew(
                message["executionGeneration"].as_u64().unwrap_or(0),
                Duration::from_millis(message["expiresInMs"].as_u64().unwrap_or(0)),
            ),
            "resume" => {
                let mut permit = state.permit.lock().unwrap();
                permit.resume(message["executionGeneration"].as_u64().unwrap_or(0));
                let active = permit.active();
                state.emergency.store(!active, Ordering::SeqCst);
                state.armed.store(active, Ordering::SeqCst);
            }
            "suspend" => {
                suspend(None);
                if !s(&message, "requestId").is_empty() {
                    emit(json!({"type":"response","requestId":message["requestId"],"result":{}}))
                }
            }
            "cancel" => {
                state
                    .permit
                    .lock()
                    .unwrap()
                    .cancel(s(&message, "requestId"));
                unsafe { release() }
            }
            "permissions" => emit_status(),
            "grantsChanged" => {
                let auth = message["authorization"].clone();
                state.grants.lock().unwrap().insert(auth_key(&auth), auth);
            }
            "request" => {
                let op = s(&message["request"], "op");
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
    let result = unsafe { execute(&message) };
    match result {
        Ok(value) => emit(json!({"type":"response","requestId":id,"result":value})),
        Err(error) => emit(json!({"type":"response","requestId":id,"error":error})),
    }
}
