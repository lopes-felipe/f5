use super::*;
use windows::Win32::UI::Input::*;

const PING: u32 = WM_APP + 6;

/// A message-only input sink never takes focus or changes another app's input.
/// Raw input registration survives idle periods; verify the registration and
/// challenge its dedicated receiver thread without injecting mouse events.
pub(super) fn start() {
    std::thread::spawn(|| loop {
        unsafe {
            let _ = run();
            let state = STATE.get().unwrap();
            state.raw_mouse_window.store(0, Ordering::SeqCst);
            state.healthy.store(false, Ordering::SeqCst);
            suspend(None);
        }
        // Receiver recovery never resumes permits; the independent probe must
        // confirm monitor health before accepting any new work.
        std::thread::sleep(Duration::from_secs(2));
    });
}

unsafe fn run() -> windows::core::Result<()> {
    let instance = HINSTANCE(windows::Win32::System::LibraryLoader::GetModuleHandleW(None)?.0);
    let class = w!("F5ComputerRawMouseMonitor");
    let definition = WNDCLASSW {
        lpfnWndProc: Some(procedure),
        hInstance: instance,
        lpszClassName: class,
        ..Default::default()
    };
    if RegisterClassW(&definition) == 0 {
        let error = windows::core::Error::from_thread();
        if error.code() != windows::Win32::Foundation::ERROR_CLASS_ALREADY_EXISTS.to_hresult() {
            return Err(error);
        }
    }
    let hwnd = CreateWindowExW(
        WINDOW_EX_STYLE(0),
        class,
        w!(""),
        WINDOW_STYLE(0),
        0,
        0,
        0,
        0,
        Some(HWND_MESSAGE),
        None,
        Some(instance),
        None,
    )?;
    let device = RAWINPUTDEVICE {
        usUsagePage: 1,
        usUsage: 2,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: hwnd,
    };
    if let Err(error) =
        RegisterRawInputDevices(&[device], std::mem::size_of::<RAWINPUTDEVICE>() as u32)
    {
        let _ = DestroyWindow(hwnd);
        return Err(error);
    }
    STATE
        .get()
        .unwrap()
        .raw_mouse_window
        .store(hwnd.0 as u64, Ordering::SeqCst);
    let mut message = MSG::default();
    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
        let _ = TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    STATE
        .get()
        .unwrap()
        .raw_mouse_window
        .store(0, Ordering::SeqCst);
    let _ = RegisterRawInputDevices(
        &[RAWINPUTDEVICE {
            dwFlags: RIDEV_REMOVE,
            hwndTarget: HWND::default(),
            ..device
        }],
        std::mem::size_of::<RAWINPUTDEVICE>() as u32,
    );
    let _ = DestroyWindow(hwnd);
    Ok(())
}

pub(super) unsafe fn registered() -> bool {
    let hwnd = HWND(STATE.get().unwrap().raw_mouse_window.load(Ordering::SeqCst) as *mut _);
    if hwnd.0.is_null() || !IsWindow(Some(hwnd)).as_bool() {
        return false;
    }
    let mut devices = [RAWINPUTDEVICE::default(); 32];
    let mut count = devices.len() as u32;
    let read = GetRegisteredRawInputDevices(
        Some(devices.as_mut_ptr()),
        &mut count,
        std::mem::size_of::<RAWINPUTDEVICE>() as u32,
    );
    read <= devices.len() as u32
        && devices[..read as usize].iter().any(|device| {
            device.usUsagePage == 1
                && device.usUsage == 2
                && device.hwndTarget == hwnd
                && device.dwFlags.contains(RIDEV_INPUTSINK)
        })
}

pub(super) unsafe fn probe(token: u64) -> bool {
    if !registered() {
        return false;
    }
    let hwnd = HWND(STATE.get().unwrap().raw_mouse_window.load(Ordering::SeqCst) as *mut _);
    PostMessageW(Some(hwnd), PING, WPARAM(token as usize), LPARAM(0)).is_ok()
}

unsafe extern "system" fn procedure(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_DESTROY {
        // Normal cleanup clears the published handle first. Do not leave a
        // second WM_QUIT queued for the next receiver on this same thread.
        if STATE.get().unwrap().raw_mouse_window.load(Ordering::SeqCst) == hwnd.0 as u64 {
            fail_receiver();
        }
        return LRESULT(0);
    }
    if message == PING {
        STATE
            .get()
            .unwrap()
            .mouse_probe
            .store(w.0 as u64, Ordering::SeqCst);
        return LRESULT(0);
    }
    if message == WM_INPUT {
        // Mouse data fits on the stack. Unexpected/truncated packets stop work;
        // never allocate based on a size supplied by an input message.
        let mut input = RAWINPUT::default();
        let mut size = std::mem::size_of::<RAWINPUT>() as u32;
        let read = GetRawInputData(
            HRAWINPUT(l.0 as *mut _),
            RID_INPUT,
            Some((&mut input as *mut RAWINPUT).cast()),
            &mut size,
            std::mem::size_of::<RAWINPUTHEADER>() as u32,
        );
        let minimum =
            (std::mem::size_of::<RAWINPUTHEADER>() + std::mem::size_of::<RAWMOUSE>()) as u32;
        if read == u32::MAX
            || read < minimum
            || read > std::mem::size_of::<RAWINPUT>() as u32
            || input.header.dwType != RIM_TYPEMOUSE.0
        {
            fail_receiver();
        } else if input.header.dwType == RIM_TYPEMOUSE.0 {
            let mouse = input.data.mouse;
            if let Some(pointer_move) = crate::safety::raw_mouse_activity(
                mouse.ulExtraInformation,
                mouse.Anonymous.Anonymous.usButtonFlags,
                mouse.usFlags.0 & MOUSE_MOVE_ABSOLUTE.0 != 0,
                mouse.lLastX,
                mouse.lLastY,
            ) {
                let mut point = POINT::default();
                if GetCursorPos(&mut point).is_ok() {
                    let buttons = mouse.Anonymous.Anonymous.usButtonFlags;
                    mouse_activity(
                        point,
                        pointer_move,
                        if buttons & (0x0400 | 0x0800) != 0 {
                            3
                        } else {
                            1
                        },
                    );
                } else {
                    fail_receiver();
                }
            }
        }
        // Required for foreground raw input cleanup; also safe for INPUTSINK.
    }
    DefWindowProcW(hwnd, message, w, l)
}
unsafe fn fail_receiver() {
    let state = STATE.get().unwrap();
    state.raw_mouse_window.store(0, Ordering::SeqCst);
    state.healthy.store(false, Ordering::SeqCst);
    state.emergency.store(true, Ordering::SeqCst);
    // Exit to the outer receiver loop, where held input is released without
    // blocking the window procedure or misreporting a physical interruption.
    PostQuitMessage(0);
}
