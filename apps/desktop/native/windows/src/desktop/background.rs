use super::*;

fn foreground_required(reason: &str) -> Value {
    json!({"_tag":"ForegroundRequired","reason":reason})
}

unsafe fn target(request: &Value, host: &Value, needed: &str) -> Result<HWND, Value> {
    check(request)?;
    let hwnd =
        app_window(s(request, "appId")).map_err(|_| foreground_required("window-unavailable"))?;
    authorize(hwnd, request, host, needed)?;
    if owner(GetForegroundWindow()).is_ok_and(|(id, _)| id == s(request, "appId")) {
        return Err(blocked("user-active"));
    }
    if let Some(slot) = control(generation(request)) {
        slot.window.store(hwnd.0 as u64, Ordering::SeqCst);
        slot.pid.store(owner(hwnd)?.1 as u64, Ordering::SeqCst);
        slot.container_pid.store(pid(hwnd) as u64, Ordering::SeqCst);
    }
    Ok(hwnd)
}

/// Accessibility-only delivery. Never routes through SendInput, SetFocus,
/// SetForegroundWindow or the foreground launch path.
pub(super) unsafe fn background_execute(request: &Value, host: &Value) -> Result<Value, Value> {
    let op = s(request, "op");
    let hwnd = target(
        request,
        host,
        if op == "type" || op == "key" || s(request, "action") == "setValue" {
            "type"
        } else {
            "click"
        },
    )?;
    let before = GetForegroundWindow();
    let mut _activation = None;
    let mut verification = None;
    match op {
        "elementAction" => {
            // Resolve patterns before dispatch so a missing pattern is a known
            // foreground requirement rather than an uncertain mutation.
            let snapshot = snapshot(request)?;
            let root = automation()?
                .ElementFromHandle(hwnd)
                .map_err(|_| fail("StaleElement"))?;
            let element = snapshot_element(&snapshot, s(request, "elementRef"), &root)?;
            if element
                .CurrentIsPassword()
                .map_err(|_| blocked("focus-unknown"))?
                .as_bool()
            {
                return Err(blocked("secure-field"));
            }
            match s(request, "action") {
                "press" => {
                    let pattern = element
                        .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        .map_err(|_| foreground_required("unsupported-in-background"))?;
                    target(request, host, "click")?;
                    snapshot_validate(&snapshot, request)?;
                    _activation = Some(cooperation::background_action(request, before));
                    mark_posted();
                    pattern.Invoke().map_err(|_| fail("OutcomeUnknown"))?;
                }
                "setValue" => {
                    let pattern = element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .map_err(|_| foreground_required("typing-unsupported"))?;
                    if pattern
                        .CurrentIsReadOnly()
                        .map_err(|_| foreground_required("typing-unsupported"))?
                        .as_bool()
                    {
                        return Err(foreground_required("typing-unsupported"));
                    }
                    target(request, host, "type")?;
                    snapshot_validate(&snapshot, request)?;
                    _activation = Some(cooperation::background_action(request, before));
                    mark_posted();
                    pattern
                        .SetValue(&BSTR::from(s(request, "value")))
                        .map_err(|_| fail("OutcomeUnknown"))?;
                    verification = Some(read_back(&pattern, s(request, "value")));
                }
                _ => return Err(foreground_required("unsupported-in-background")),
            }
        }
        "type" => {
            let process = owner(hwnd)?.1;
            let root = automation()?
                .ElementFromHandle(hwnd)
                .map_err(|_| foreground_required("typing-unsupported"))?;
            let (nodes, complete) = walk_checked(&root, 4000);
            if !complete {
                return Err(foreground_required("typing-unsupported"));
            }
            let mut values = Vec::new();
            for element in nodes {
                if element.CurrentProcessId().ok().map(|id| id as u32) != Some(process) {
                    continue;
                }
                let focused = element
                    .CurrentHasKeyboardFocus()
                    .map(|value| value.as_bool())
                    .unwrap_or(false);
                let secure = element
                    .CurrentIsPassword()
                    .map(|value| value.as_bool())
                    .unwrap_or(true);
                if secure && focused {
                    return Ok(
                        json!({"displayId":"unknown","geometryGeneration":"unknown","frontmostApp":null,"cursor":null,"actionCompleted":false,"delivery":"background","target":{"appId":s(request,"appId")},"waiting":"secure-input"}),
                    );
                }
                if secure
                    || !element
                        .CurrentIsEnabled()
                        .map(|value| value.as_bool())
                        .unwrap_or(false)
                {
                    continue;
                }
                if let Ok(pattern) =
                    element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                {
                    if pattern
                        .CurrentIsReadOnly()
                        .map(|value| !value.as_bool())
                        .unwrap_or(false)
                    {
                        values.push((focused, element, pattern));
                    }
                }
            }
            let focused: Vec<_> = values
                .iter()
                .enumerate()
                .filter(|(_, (focused, _, _))| *focused)
                .map(|(i, _)| i)
                .collect();
            if focused.len() != 1 {
                return Err(foreground_required("typing-unsupported"));
            }
            let index = focused[0];
            let (_, element, pattern) = &values[index];
            target(request, host, "type")?;
            if element
                .CurrentIsPassword()
                .map_err(|_| blocked("focus-unknown"))?
                .as_bool()
            {
                return Err(blocked("secure-field"));
            }
            // ValuePattern replaces the whole value. Recover the actual
            // selection through TextPattern; never assume the caret is at EOF.
            let prior = pattern
                .CurrentValue()
                .map_err(|_| foreground_required("typing-unsupported"))?
                .to_string();
            if prior.len() > 40_000 {
                return Err(foreground_required("typing-unsupported"));
            }
            let text = insertion_value(element, &prior, s(request, "text"))?;
            target(request, host, "type")?;
            if pattern
                .CurrentValue()
                .map_err(|_| foreground_required("typing-unsupported"))?
                .to_string()
                != prior
            {
                return Err(foreground_required("typing-unsupported"));
            }
            check(request)?;
            if !element
                .CurrentHasKeyboardFocus()
                .map(|value| value.as_bool())
                .unwrap_or(false)
            {
                return Err(foreground_required("typing-unsupported"));
            }
            _activation = Some(cooperation::background_action(request, before));
            mark_posted();
            pattern
                .SetValue(&BSTR::from(text.as_str()))
                .map_err(|_| fail("OutcomeUnknown"))?;
            verification = Some(read_back(pattern, &text));
        }
        "key" | "scroll" => {
            _activation = Some(cooperation::background_action(request, before));
            verification = Some(background_events::execute(request, host, hwnd)?);
        }
        "openApp" => {} // Already running: do not activate it. New launches require takeover.
        _ => return Err(foreground_required("unsupported-in-background")),
    }
    emit(json!({"type":"actionConfirmed","requestId":request["requestId"]}));
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if GetForegroundWindow() != before
            && owner(GetForegroundWindow()).is_ok_and(|(id, _)| id == s(request, "appId"))
        {
            suspend_generation(Some(generation(request)));
            emit(
                json!({"type":"activationIncident","executionGeneration":generation(request),"appId":s(request,"appId")}),
            );
            return Err(foreground_required("activation-side-effect"));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let display = displays().into_iter().find(|display| {
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).is_ok()
            && rect.left < display.bounds.right
            && rect.right > display.bounds.left
            && rect.top < display.bounds.bottom
            && rect.bottom > display.bounds.top
    });
    let mut result = json!({"displayId":display.as_ref().map(|d|d.id.as_str()).unwrap_or("unknown"),"geometryGeneration":display.as_ref().map(|d|d.generation.as_str()).unwrap_or("unknown"),"frontmostApp":null,"cursor":null,"actionCompleted":true,"delivery":"background","target":{"appId":s(request,"appId")}});
    if let Some(verification) = verification {
        result["verification"] = verification;
    }
    if request["screenshot"] == true {
        let mut capture_request = request.clone();
        capture_request["op"] = json!("screenshot");
        if let Some(display) = display {
            capture_request["displayId"] = json!(display.id);
        }
        match capture_after_action(&capture_request, host) {
            Ok(image) => result["screenshot"] = image,
            Err(error) => result["screenshotError"] = error["_tag"].clone(),
        }
    }
    Ok(result)
}
unsafe fn read_back(pattern: &IUIAutomationValuePattern, expected: &str) -> Value {
    match pattern.CurrentValue() {
        Ok(value) => {
            let value = value.to_string();
            json!({"verified":value == expected,"matchesRequestedValue":value == expected,"valueLength":value.encode_utf16().count()})
        }
        Err(_) => json!({"verified":false}),
    }
}
unsafe fn insertion_value(
    element: &IUIAutomationElement,
    prior: &str,
    text: &str,
) -> Result<String, Value> {
    if prior.is_empty() {
        return Ok(text.to_owned());
    }
    let value = (|| -> windows::core::Result<Option<String>> {
        let pattern = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)?;
        let selections = pattern.GetSelection()?;
        if selections.Length()? != 1 {
            return Ok(None);
        }
        let selection = selections.GetElement(0)?;
        let prefix = pattern.DocumentRange()?.Clone()?;
        prefix.MoveEndpointByRange(
            TextPatternRangeEndpoint_End,
            &selection,
            TextPatternRangeEndpoint_Start,
        )?;
        let suffix = pattern.DocumentRange()?.Clone()?;
        suffix.MoveEndpointByRange(
            TextPatternRangeEndpoint_Start,
            &selection,
            TextPatternRangeEndpoint_End,
        )?;
        Ok(crate::safety::insert_selected_text(
            prior,
            &prefix.GetText(40001)?.to_string(),
            &selection.GetText(40001)?.to_string(),
            &suffix.GetText(40001)?.to_string(),
            text,
        ))
    })();
    value
        .ok()
        .flatten()
        .ok_or_else(|| foreground_required("typing-unsupported"))
}
