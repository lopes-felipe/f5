use super::*;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use windows::Graphics::{
    Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem},
    DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
};
use windows::Win32::{
    Graphics::{Direct3D::*, Direct3D11::*, Dxgi::IDXGIDevice},
    System::WinRT::{
        Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
        Graphics::Capture::IGraphicsCaptureItemInterop,
    },
};

const MAX_PIXELS: usize = 32 * 1024 * 1024;
fn byte_count(rect: RECT) -> Option<usize> {
    let w = usize::try_from(rect.right.checked_sub(rect.left)?).ok()?;
    let h = usize::try_from(rect.bottom.checked_sub(rect.top)?).ok()?;
    if w == 0 || h == 0 || w > 16384 || h > 16384 || w.checked_mul(h)? > MAX_PIXELS {
        return None;
    }
    w.checked_mul(h)?.checked_mul(4)
}

/// A disposable process contains APIs that can block in a target application's
/// window procedure or graphics driver. Its stdin is a parent-death watchdog.
pub(super) unsafe fn worker(hwnd: HWND) -> windows::core::Result<()> {
    std::thread::spawn(|| {
        let mut byte = [0];
        let _ = std::io::stdin().read(&mut byte);
        std::process::exit(1);
    });
    let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let (rect, pixels) = graphics_capture(hwnd).or_else(|_| print_window(hwnd))?;
    let mut output = std::io::stdout().lock();
    for value in [rect.left, rect.top, rect.right, rect.bottom] {
        output
            .write_all(&value.to_le_bytes())
            .map_err(|_| windows::core::Error::from_thread())?;
    }
    output
        .write_all(&pixels)
        .map_err(|_| windows::core::Error::from_thread())?;
    Ok(())
}

unsafe fn graphics_capture(hwnd: HWND) -> windows::core::Result<(RECT, Vec<u8>)> {
    let mut device = None;
    let mut context = None;
    D3D11CreateDevice(
        None,
        D3D_DRIVER_TYPE_HARDWARE,
        HMODULE::default(),
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        None,
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        Some(&mut context),
    )?;
    let device = device.unwrap();
    let context = context.unwrap();
    let dxgi: IDXGIDevice = device.cast()?;
    let runtime: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
    let size = item.Size()?;
    let mut bounds = RECT::default();
    DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        (&mut bounds as *mut RECT).cast(),
        std::mem::size_of::<RECT>() as u32,
    )?;
    if bounds.right - bounds.left != size.Width || bounds.bottom - bounds.top != size.Height {
        GetWindowRect(hwnd, &mut bounds)?;
    }
    let length = byte_count(bounds).ok_or_else(windows::core::Error::from_thread)?;
    if bounds.right - bounds.left != size.Width || bounds.bottom - bounds.top != size.Height {
        return Err(windows::core::Error::from_thread());
    }
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &runtime,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        1,
        size,
    )?;
    let session = pool.CreateCaptureSession(&item)?;
    session.SetIsCursorCaptureEnabled(false)?;
    session.StartCapture()?;
    let deadline = Instant::now() + Duration::from_millis(750);
    let frame = loop {
        if let Ok(frame) = pool.TryGetNextFrame() {
            break frame;
        }
        if Instant::now() >= deadline {
            return Err(windows::core::Error::from_thread());
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let content = frame.ContentSize()?;
    if content.Width != size.Width || content.Height != size.Height {
        return Err(windows::core::Error::from_thread());
    }
    let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
    let texture: ID3D11Texture2D = access.GetInterface()?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    texture.GetDesc(&mut desc);
    if desc.Width < size.Width as u32 || desc.Height < size.Height as u32 {
        return Err(windows::core::Error::from_thread());
    }
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.MiscFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    let mut staging = None;
    device.CreateTexture2D(&desc, None, Some(&mut staging))?;
    let staging = staging.unwrap();
    context.CopyResource(&staging, &texture);
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
    let row = size.Width as usize * 4;
    let mut pixels = vec![0; length];
    if mapped.RowPitch as usize >= row && !mapped.pData.is_null() {
        for y in 0..size.Height as usize {
            pixels[y * row..(y + 1) * row].copy_from_slice(std::slice::from_raw_parts(
                (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                row,
            ));
        }
    } else {
        context.Unmap(&staging, 0);
        return Err(windows::core::Error::from_thread());
    }
    context.Unmap(&staging, 0);
    frame.Close()?;
    session.Close()?;
    pool.Close()?;
    Ok((bounds, pixels))
}

unsafe fn print_window(hwnd: HWND) -> windows::core::Result<(RECT, Vec<u8>)> {
    let mut rect = RECT::default();
    GetWindowRect(hwnd, &mut rect)?;
    let length = byte_count(rect).ok_or_else(windows::core::Error::from_thread)?;
    let dc = CreateCompatibleDC(None);
    if dc.0.is_null() {
        return Err(windows::core::Error::from_thread());
    }
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: rect.right - rect.left,
        biHeight: -(rect.bottom - rect.top),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(bitmap) => bitmap,
        Err(error) => {
            let _ = DeleteDC(dc);
            return Err(error);
        }
    };
    let old = SelectObject(dc, HGDIOBJ(bitmap.0));
    let success = PrintWindow(hwnd, dc, PRINT_WINDOW_FLAGS(2)).as_bool() && !bits.is_null();
    let pixels = if success {
        Some(std::slice::from_raw_parts(bits as *const u8, length).to_vec())
    } else {
        None
    };
    SelectObject(dc, old);
    let _ = DeleteObject(HGDIOBJ(bitmap.0));
    let _ = DeleteDC(dc);
    pixels
        .map(|pixels| (rect, pixels))
        .ok_or_else(windows::core::Error::from_thread)
}

pub(super) fn capture(hwnd: HWND, request: &Value) -> Result<(RECT, Vec<u8>), Value> {
    let executable = std::env::current_exe().map_err(|_| fail("Execution"))?;
    let mut child = Command::new(executable)
        .args(["--capture-window", &(hwnd.0 as usize).to_string()])
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| fail("Execution"))?;
    let mut output = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || -> Option<(RECT, Vec<u8>)> {
        let mut header = [0u8; 16];
        output.read_exact(&mut header).ok()?;
        let number = |index| i32::from_le_bytes(header[index..index + 4].try_into().unwrap());
        let rect = RECT {
            left: number(0),
            top: number(4),
            right: number(8),
            bottom: number(12),
        };
        let mut pixels = vec![0; byte_count(rect)?];
        output.read_exact(&mut pixels).ok()?;
        Some((rect, pixels))
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    let outcome = loop {
        if let Err(error) = check_observation(request) {
            break Err(error);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err(fail("Execution"))
                }
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => break Err(json!({"_tag":"Execution","message":"Window capture timed out."})),
        }
    };
    // Always reap, including cancellation and timeout. No capture worker survives
    // its helper: closing the parent's stdin pipe also terminates its watchdog.
    let _ = child.kill();
    let _ = child.wait();
    let pixels = reader.join().ok().flatten();
    outcome?;
    pixels.ok_or(fail("Execution"))
}
