use super::*;

pub(super) unsafe fn automation() -> Result<IUIAutomation, Value> {
    thread_local! {
        static CLIENT: std::cell::RefCell<Option<IUIAutomation>> = const { std::cell::RefCell::new(None) };
        static COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    if !COM_READY.with(|ready| {
        if !ready.get() {
            ready.set(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() });
        }
        ready.get()
    }) {
        return Err(blocked("focus-unknown"));
    }
    CLIENT.with(|cell| {
        if let Some(client) = cell.borrow().as_ref() {
            return Ok(client.clone());
        }
        let client = unsafe { create_automation() }?;
        *cell.borrow_mut() = Some(client.clone());
        Ok(client)
    })
}
unsafe fn create_automation() -> Result<IUIAutomation, Value> {
    let uia: IUIAutomation2 = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
        .map_err(|_| blocked("focus-unknown"))?;
    uia.SetAutoSetFocus(false)
        .map_err(|_| blocked("focus-unknown"))?;
    uia.SetConnectionTimeout(250)
        .map_err(|_| blocked("focus-unknown"))?;
    uia.SetTransactionTimeout(250)
        .map_err(|_| blocked("focus-unknown"))?;
    uia.cast().map_err(|_| blocked("focus-unknown"))
}
pub(super) unsafe fn focused(
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
pub(super) unsafe fn runtime_id(element: &IUIAutomationElement) -> Result<String, Value> {
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
pub(super) unsafe fn walk(root: &IUIAutomationElement, max: usize) -> Vec<IUIAutomationElement> {
    walk_checked(root, max).0
}
pub(super) unsafe fn walk_checked(
    root: &IUIAutomationElement,
    max: usize,
) -> (Vec<IUIAutomationElement>, bool) {
    let (output, report) = walk_report(root, max);
    (output, report.complete)
}
unsafe fn walk_report(
    root: &IUIAutomationElement,
    max: usize,
) -> (Vec<IUIAutomationElement>, crate::traversal::Report) {
    let unavailable = || (Vec::new(), crate::traversal::Report::default());
    let Ok(uia) = automation() else {
        return unavailable();
    };
    let Ok(walker) = uia.ControlViewWalker() else {
        return unavailable();
    };
    let optional = |value: windows::core::Result<IUIAutomationElement>| {
        crate::traversal::optional(value.map_err(|error| error.code().0))
    };
    crate::traversal::walk(
        root.clone(),
        max,
        Duration::from_secs(1),
        |node| optional(walker.GetFirstChildElement(node)),
        |node| optional(walker.GetNextSiblingElement(node)),
    )
}
pub(super) unsafe fn app_window(id: &str) -> Result<HWND, Value> {
    windows()
        .into_iter()
        .find(|hwnd| {
            IsWindowVisible(*hwnd).as_bool()
                && owner(*hwnd).map(|(app, _)| app == id).unwrap_or(false)
        })
        .ok_or(fail("StaleElement"))
}
pub(super) unsafe fn inspect(request: &Value, host: &Value) -> Result<Value, Value> {
    check_observation_delivery(request, host)?;
    let app = s(request, "appId");
    let prior = if !s(request, "snapshotId").is_empty() {
        Some(snapshot(request)?)
    } else {
        None
    };
    if !s(request, "elementRef").is_empty() && prior.is_none() {
        return Err(fail("StaleElement"));
    }
    let hwnd = match prior.as_ref() {
        Some(prior) => HWND(prior.hwnd as *mut _),
        None => app_window(app)?,
    };
    authorize(hwnd, request, host, "view")?;
    let snapshot_id = uuid::Uuid::new_v4().to_string();
    let Ok(uia) = automation() else {
        return Ok(json!({"snapshotId":snapshot_id,"appId":app,"accessible":false,"nodes":[]}));
    };
    let Ok(mut root) = uia.ElementFromHandle(hwnd) else {
        return Ok(json!({"snapshotId":snapshot_id,"appId":app,"accessible":false,"nodes":[]}));
    };
    if let Some(prior) = &prior {
        if !s(request, "elementRef").is_empty() {
            root = snapshot_element(prior, s(request, "elementRef"), &root)?;
        }
    }
    let mut nodes = Vec::new();
    let mut elements = HashMap::new();
    let process_id = owner(hwnd)?.1;
    let process_birth = process_started(process_id)?;
    let (visited, report) = walk_report(&root, n(request, "maxNodes").clamp(1, 800) as usize);
    let visited_count = visited.len();
    let mut process_skipped = 0usize;
    let mut runtime_skipped = 0usize;
    for element in visited {
        if element.CurrentProcessId().ok().map(|id| id as u32) != Some(process_id) {
            process_skipped += 1;
            continue;
        }
        let Ok(runtime) = runtime_id(&element) else {
            runtime_skipped += 1;
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
        process_started: process_birth,
        authorization: snapshot_authorization(request),
        elements,
    };
    let state = STATE.get().unwrap();
    let mut cache = state.snapshots.lock().unwrap();
    if cache.len() >= 256 {
        cache.clear();
    }
    let entries = cache.entry(snapshot_key(request)).or_default();
    entries.push(snapshot);
    if entries.len() > 4 {
        entries.remove(0);
    }
    drop(cache);
    check_observation_delivery(request, host)?;
    authorize(hwnd, request, host, "view")?;
    if process_started(process_id)? != process_birth {
        return Err(fail("StaleElement"));
    }
    emit(json!({
        "type":"accessibilityTraversal", "requestId":request["requestId"],
        "complete":report.complete, "visited":visited_count, "reported":nodes.len(),
        "processSkipped":process_skipped, "runtimeSkipped":runtime_skipped,
        "errors":report.errors.iter().map(|code|format!("{:08X}", *code as u32)).collect::<Vec<_>>(),
    }));
    let value = json!({"snapshotId":snapshot_id,"appId":app,"accessible":true,"truncated":!report.complete,"nodes":nodes});
    if serde_json::to_vec(&value).unwrap().len() > 256 * 1024 {
        return Err(fail("ResultTooLarge"));
    }
    Ok(value)
}
pub(super) unsafe fn element_action(request: &Value, host: &Value) -> Result<(), Value> {
    check(request)?;
    let snapshot = snapshot(request)?;
    let hwnd = HWND(snapshot.hwnd as *mut _);
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
    let uia = automation()?;
    let root = uia
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
    if element
        .CurrentProcessId()
        .map_err(|_| fail("StaleElement"))? as u32
        != snapshot.pid
    {
        return Err(fail("StaleElement"));
    }
    check(request)?;
    snapshot_validate(&snapshot, request)?;
    mark_posted();
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
    result.map_err(|_| fail("OutcomeUnknown"))
}
pub(super) fn snapshot_authorization(request: &Value) -> Value {
    let auth = &request["authorization"];
    json!({"profileId":auth["profileId"],"threadId":auth["threadId"],"sessionGeneration":auth["sessionGeneration"],"grantVersion":auth["grantVersion"],"grants":auth["grants"]})
}
pub(super) fn snapshot_key(request: &Value) -> String {
    format!(
        "{}\0{}",
        auth_key(&request["authorization"]),
        s(request, "appId")
    )
}
pub(super) unsafe fn snapshot_validate(snapshot: &Snapshot, request: &Value) -> Result<(), Value> {
    let hwnd = HWND(snapshot.hwnd as *mut _);
    if snapshot.authorization != snapshot_authorization(request)
        || !IsWindow(Some(hwnd)).as_bool()
        || owner(hwnd)? != (s(request, "appId").to_owned(), snapshot.pid)
        || process_started(snapshot.pid)? != snapshot.process_started
    {
        return Err(fail("StaleElement"));
    }
    Ok(())
}
pub(super) unsafe fn snapshot(request: &Value) -> Result<Snapshot, Value> {
    let snapshot = STATE
        .get()
        .unwrap()
        .snapshots
        .lock()
        .unwrap()
        .get(&snapshot_key(request))
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.id == s(request, "snapshotId"))
        })
        .cloned()
        .ok_or(fail("StaleElement"))?;
    snapshot_validate(&snapshot, request)?;
    Ok(snapshot)
}
pub(super) unsafe fn snapshot_element(
    snapshot: &Snapshot,
    reference: &str,
    root: &IUIAutomationElement,
) -> Result<IUIAutomationElement, Value> {
    let identity = snapshot
        .elements
        .get(reference)
        .ok_or(fail("StaleElement"))?;
    walk(root, 4000)
        .into_iter()
        .find(|element| {
            element.CurrentProcessId().ok().map(|id| id as u32) == Some(snapshot.pid)
                && runtime_id(element).is_ok_and(|id| id == *identity)
        })
        .ok_or(fail("StaleElement"))
}
