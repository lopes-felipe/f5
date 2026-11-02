use super::*;

pub(super) fn mask_rect(canvas: &mut RgbaImage, rect: RECT, display: &RECT) {
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
pub(super) unsafe fn capture_after_action(request: &Value, host: &Value) -> Result<Value, Value> {
    let mut scoped_host = host.clone();
    scoped_host["observationGenerationOwner"] = json!(execution_owner(request));
    capture(request, &scoped_host)
}
pub(super) unsafe fn capture(request: &Value, host: &Value) -> Result<Value, Value> {
    static CAPTURES: AtomicU64 = AtomicU64::new(0);
    if CAPTURES.fetch_add(1, Ordering::SeqCst) >= 2 {
        CAPTURES.fetch_sub(1, Ordering::SeqCst);
        return Err(json!({"_tag":"Busy","holder":"same-profile","reason":"observation-backlog"}));
    }
    struct CaptureSlot(&'static AtomicU64);
    impl Drop for CaptureSlot {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    let _slot = CaptureSlot(&CAPTURES);
    check_observation_delivery(request, host)?;
    let scoped = !s(request, "appId").is_empty();
    // App authorization is independent of display selection. In particular,
    // revoked scoped zoom/capture must fail before enumerating any surfaces.
    let scoped_window = if scoped {
        let hwnd = app_window(s(request, "appId"))?;
        authorize(hwnd, request, host, "view")?;
        Some(hwnd)
    } else {
        None
    };
    let target = if let Some(hwnd) = scoped_window.filter(|_| s(request, "displayId").is_empty()) {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|_| fail("GeometryChanged"))?;
        displays()
            .into_iter()
            .find(|display| {
                rect.left < display.bounds.right
                    && rect.right > display.bounds.left
                    && rect.top < display.bounds.bottom
                    && rect.bottom > display.bounds.top
            })
            .ok_or(json!({"_tag":"ForegroundRequired","reason":"window-unavailable"}))?
    } else {
        select_display(request)?
    };
    let w = (target.bounds.right - target.bounds.left) as u32;
    let h = (target.bounds.bottom - target.bounds.top) as u32;
    if w > 16384 || h > 16384 || u64::from(w) * u64::from(h) > 32 * 1024 * 1024 {
        return Err(fail("ResultTooLarge"));
    }
    let mut canvas = RgbaImage::from_pixel(w, h, Rgba([115, 115, 115, 255]));
    let mut hidden = false;
    let mut masked_fields = false;
    let mut masked_window = false;
    let mode = if s(request, "passwordMasking") == "fast" {
        "fast"
    } else {
        "conservative"
    };
    let mut captured = Vec::new();
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
        if (scoped
            && owner(hwnd)
                .map(|(id, _)| id != s(request, "appId"))
                .unwrap_or(true))
            || authorize(hwnd, request, host, "view").is_err()
        {
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
        let process_id = owner(hwnd)?.1;
        let birth = process_started(process_id)?;
        let initial_window_rect = capture_rect;
        let (before_masks, before_complete) = password_audit(hwnd, process_id, mode);
        let Ok((buffer_rect, pixels)) = capture_worker::capture(hwnd, request) else {
            hidden = true;
            masked_window = true;
            mask_rect(&mut canvas, rect, &target.bounds);
            continue;
        };
        let same_rect = |a: RECT, b: RECT| {
            a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
        };
        if (!same_rect(buffer_rect, initial_window_rect) && !same_rect(buffer_rect, rect))
            || owner(hwnd)?.1 != process_id
            || process_started(process_id)? != birth
            || authorize(hwnd, request, host, "view").is_err()
        {
            return Err(json!({"_tag":"Interrupted","cause":"access-changed"}));
        }
        capture_rect = buffer_rect;
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
            &pixels,
        ) {
            hidden = true;
            masked_window = true;
            mask_rect(&mut canvas, capture_rect, &target.bounds);
        }
        captured.push((hwnd.0 as isize, process_id, birth, initial_window_rect));
        let mut current_bounds = RECT::default();
        let (after_masks, after_complete) = password_audit(hwnd, process_id, mode);
        let incomplete = !before_complete
            || !after_complete
            || GetWindowRect(hwnd, &mut current_bounds).is_err()
            || !same_rect(current_bounds, initial_window_rect);
        for secure in before_masks.into_iter().chain(after_masks) {
            masked_fields = true;
            mask_rect(&mut canvas, secure, &target.bounds);
        }
        if incomplete {
            hidden = true;
            masked_window = true;
            mask_rect(&mut canvas, capture_rect, &target.bounds);
        }
    }
    check_observation_delivery(request, host)?;
    if !displays()
        .iter()
        .any(|display| display.id == target.id && display.generation == target.generation)
    {
        return Err(fail("GeometryChanged"));
    }
    if scoped && captured.is_empty() {
        return Err(json!({"_tag":"ForegroundRequired","reason":"window-unavailable"}));
    }
    for (window, process, birth, bounds) in captured {
        let hwnd = HWND(window as *mut _);
        let mut current = RECT::default();
        if authorize(hwnd, request, host, "view").is_err()
            || owner(hwnd)?.1 != process
            || process_started(process)? != birth
            || GetWindowRect(hwnd, &mut current).is_err()
            || current.left != bounds.left
            || current.top != bounds.top
            || current.right != bounds.right
            || current.bottom != bounds.bottom
        {
            return Err(json!({"_tag":"Interrupted","cause":"access-changed"}));
        }
    }
    hidden |= masked_fields || masked_window;
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
    value["passwordMasking"] = json!(mode);
    value["masked"] = json!(if masked_window {
        "window"
    } else if masked_fields {
        "fields"
    } else {
        "none"
    });
    value["maskReasons"] = if masked_window {
        json!(["audit-incomplete"])
    } else {
        json!([])
    };
    check_observation_delivery(request, host)?;
    if zoom {
        value["rect"] = request["rect"].clone()
    }
    Ok(value)
}

/// Fast mode asks the provider for password elements directly. Conservative mode
/// audits the complete control tree. Failure in either path masks the window.
pub(super) unsafe fn secure_elements(
    root: &IUIAutomationElement,
    mode: &str,
) -> (Vec<IUIAutomationElement>, bool) {
    if mode != "fast" {
        return walk_checked(root, 4000);
    }
    let found = (|| -> windows::core::Result<Vec<IUIAutomationElement>> {
        let uia = automation().map_err(|_| windows::core::Error::from_thread())?;
        let condition = uia.CreatePropertyCondition(
            UIA_IsPasswordPropertyId,
            &windows::Win32::System::Variant::VARIANT::from(true),
        )?;
        let matches = root.FindAll(TreeScope_Subtree, &condition)?;
        let length = matches.Length()?;
        if !(0..=512).contains(&length) {
            return Err(windows::core::Error::from_thread());
        }
        (0..length).map(|index| matches.GetElement(index)).collect()
    })();
    match found {
        Ok(elements) => (elements, true),
        Err(_) => (Vec::new(), false),
    }
}

/// Audit on both sides of capture so disappearing secure controls remain masked.
unsafe fn password_audit(hwnd: HWND, process_id: u32, mode: &str) -> (Vec<RECT>, bool) {
    let mut masks = Vec::new();
    let Ok(root) = automation().and_then(|uia| {
        uia.ElementFromHandle(hwnd)
            .map_err(|_| blocked("focus-unknown"))
    }) else {
        return (masks, false);
    };
    let root_pid = root.CurrentProcessId().ok().map(|id| id as u32);
    // A packaged app may have an ApplicationFrameHost top-level container. Its
    // owner is independently resolved and authorized before either audit.
    let mut complete = root_pid == Some(process_id) || root_pid == Some(pid(hwnd));
    let (elements, walked) = secure_elements(&root, mode);
    complete &= walked;
    for element in elements {
        match element.CurrentIsPassword() {
            Ok(secure) if secure.as_bool() => match element.CurrentBoundingRectangle() {
                Ok(rect) if rect.right > rect.left && rect.bottom > rect.top => masks.push(rect),
                _ => complete = false,
            },
            Err(_) => complete = false,
            _ => {}
        }
    }
    (masks, complete)
}
