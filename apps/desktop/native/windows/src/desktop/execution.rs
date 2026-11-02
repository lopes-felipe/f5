use super::*;

pub(super) fn auth_key(auth: &Value) -> String {
    format!("{}\0{}", s(auth, "profileId"), s(auth, "threadId"))
}
pub(super) fn generation(request: &Value) -> u64 {
    request["authorization"]["executionGeneration"]
        .as_u64()
        .unwrap_or(0)
}
pub(super) fn execution_owner(request: &Value) -> String {
    format!(
        "{}\0{}",
        auth_key(&request["authorization"]),
        s(&request["authorization"], "sessionGeneration")
    )
}
pub(super) fn bind_observation_scope(message: &mut Value) {
    let request = &message["request"];
    if !["inspect", "screenshot", "zoom"].contains(&s(request, "op")) {
        return;
    }
    let current_owner = STATE
        .get()
        .unwrap()
        .generation_owners
        .lock()
        .unwrap()
        .get(&generation(request))
        .filter(|owner| **owner == execution_owner(request))
        .cloned();
    // Always override caller input. This metadata exists only in the helper queue.
    message["hostAuthorization"]["observationGenerationOwner"] = json!(current_owner);
}
pub(super) fn control(generation: u64) -> Option<&'static GenerationControl> {
    STATE
        .get()?
        .controls
        .iter()
        .find(|entry| entry.generation.load(Ordering::SeqCst) == generation)
}
pub(super) unsafe fn resume_generation(message: &Value) {
    let state = STATE.get().unwrap();
    let generation = message["executionGeneration"].as_u64().unwrap_or(0);
    let sequence = state.input_sequence.load(Ordering::SeqCst);
    if message["inputSequence"]
        .as_u64()
        .is_some_and(|expected| expected != sequence)
    {
        emit(json!({"type":"physicalInput","executionGeneration":generation}));
        return;
    }
    let scope = state.permit.lock().unwrap().scope(generation).cloned();
    let Some(scope) = scope else { return };
    if !message["scope"].is_null() && Scope::decode(&message["scope"]).as_ref() != Some(&scope) {
        return;
    }
    let Some(slot) = control(generation).or_else(|| {
        state
            .controls
            .iter()
            .find(|entry| entry.generation.load(Ordering::SeqCst) == 0)
    }) else {
        return;
    };
    let window = scope
        .app()
        .and_then(|app| app_window(app).ok())
        .unwrap_or_default();
    let process = owner(window).map(|(_, pid)| pid).unwrap_or(0);
    slot.paused.store(true, Ordering::SeqCst);
    slot.input_pending.store(0, Ordering::SeqCst);
    slot.generation.store(generation, Ordering::SeqCst);
    slot.window.store(window.0 as u64, Ordering::SeqCst);
    slot.pid.store(process as u64, Ordering::SeqCst);
    slot.container_pid
        .store(pid(window) as u64, Ordering::SeqCst);
    slot.background.store(scope.background(), Ordering::SeqCst);
    state.emergency.store(false, Ordering::SeqCst);
    state
        .permit
        .lock()
        .unwrap()
        .resume(generation, Some(&scope));
    let valid = state.permit.lock().unwrap().valid(generation, "");
    slot.paused.store(!valid, Ordering::SeqCst);
    // The hook may have fired during arming. Never clear its latch afterward.
    if state.input_sequence.load(Ordering::SeqCst) != sequence {
        slot.paused.store(true, Ordering::SeqCst);
        state.permit.lock().unwrap().suspend(Some(generation));
        emit(json!({"type":"physicalInput","executionGeneration":generation}));
    }
}
pub(super) fn suspend_generation(generation: Option<u64>) {
    let state = STATE.get().unwrap();
    let foreground = generation
        .and_then(|id| state.permit.lock().unwrap().scope(id).cloned())
        .is_some_and(|scope| !scope.background());
    for slot in &state.controls {
        if generation.is_none_or(|generation| generation == slot.generation.load(Ordering::SeqCst))
        {
            slot.paused.store(true, Ordering::SeqCst);
        }
    }
    state.permit.lock().unwrap().suspend(generation);
    if foreground || generation.is_none() {
        unsafe { release() };
    }
}
pub(super) fn check_grants(request: &Value) -> Result<(), Value> {
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
pub(super) fn check_observation(request: &Value) -> Result<(), Value> {
    check_grants(request)?;
    let state = STATE.get().unwrap();
    if !state.monitors_ready() {
        return Err(json!({"_tag":"Unavailable","reason":"monitor-unhealthy"}));
    }
    // Observation-only requests use generation 1 until they acquire a lease.
    // Never apply another profile/thread's generation latch to those requests.
    let owned = state
        .generation_owners
        .lock()
        .unwrap()
        .get(&generation(request))
        .is_some_and(|owner| *owner == execution_owner(request));
    if owned
        && control(generation(request)).is_some_and(|control| control.paused.load(Ordering::SeqCst))
    {
        return Err(json!({"_tag":"Interrupted","cause":"paused"}));
    }
    if owned {
        let mut permits = state.permit.lock().unwrap();
        if !permits.valid(generation(request), s(request, "requestId")) {
            return Err(json!({"_tag":"Interrupted","cause":"permit-expired"}));
        }
        if s(request, "delivery") == "background"
            && !permits.scope(generation(request)).is_some_and(|scope| {
                scope.allows(
                    "background",
                    s(request, "op"),
                    s(request, "appId"),
                    s(request, "action"),
                )
            })
        {
            return Err(json!({"_tag":"ForegroundRequired","reason":"unsupported-in-background"}));
        }
    }
    if s(request, "delivery") == "background" && s(request, "appId").is_empty() {
        return Err(json!({"_tag":"ForegroundRequired","reason":"unsupported-in-background"}));
    }
    if request["deadlineAtMs"].as_u64().unwrap_or(0)
        <= SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    {
        return Err(json!({"_tag":"Interrupted","cause":"permit-expired"}));
    }
    unsafe { interactive_desktop() }
}
/// The IPC reader stamps ownership before queueing an observation. Retirement
/// must not turn an in-flight scoped capture into an unscoped observation merely
/// because generation_owners was cleared. Fresh read-only requests remain valid.
pub(super) fn check_observation_delivery(request: &Value, host: &Value) -> Result<(), Value> {
    check_observation(request)?;
    if let Some(expected) = host["observationGenerationOwner"].as_str() {
        let state = STATE.get().unwrap();
        let owners = state.generation_owners.lock().unwrap();
        if owners.get(&generation(request)).map(String::as_str) != Some(expected) {
            return Err(json!({"_tag":"Interrupted","cause":"access-changed"}));
        }
    }
    Ok(())
}
pub(super) fn check(request: &Value) -> Result<(), Value> {
    let state = STATE.get().unwrap();
    if state.emergency.load(Ordering::SeqCst) {
        return Err(json!({"_tag":"Interrupted","cause":"paused"}));
    }
    if !state.monitors_ready() {
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
    let generation = request["authorization"]["executionGeneration"]
        .as_u64()
        .unwrap_or(0);
    let permits = state.permit.lock().unwrap();
    let scope = permits
        .scope(generation)
        .ok_or(json!({"_tag":"Interrupted","cause":"permit-expired"}))?;
    if !scope.allows(
        s(request, "delivery"),
        s(request, "op"),
        s(request, "appId"),
        s(request, "action"),
    ) {
        return Err(json!({"_tag":"ForegroundRequired","reason":"unsupported-in-background"}));
    }
    if state.controls.iter().any(|control| {
        control.generation.load(Ordering::SeqCst) == generation
            && control.paused.load(Ordering::SeqCst)
    }) {
        return Err(json!({"_tag":"Interrupted","cause":"user-input"}));
    }
    drop(permits);
    unsafe {
        interactive_desktop()?;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    if now >= request["deadlineAtMs"].as_u64().unwrap_or(0) {
        return Err(json!({"_tag":"Interrupted","cause":"permit-expired"}));
    }
    check_grants(request)?;
    let mut owners = state.generation_owners.lock().unwrap();
    let owner = owners
        .entry(generation)
        .or_insert_with(|| execution_owner(request));
    if *owner != execution_owner(request) {
        return Err(fail("ReplayRejected"));
    }
    Ok(())
}
pub(super) unsafe fn interactive_desktop() -> Result<(), Value> {
    if STATE
        .get()
        .is_some_and(|state| !state.session_connected.load(Ordering::SeqCst))
    {
        return Err(
            json!({"_tag":"Unavailable","reason":"missing-permissions","detail":"Reconnect to the Windows session before using computer control."}),
        );
    }
    let desktop = OpenInputDesktop(DF_ALLOWOTHERACCOUNTHOOK, false, DESKTOP_READOBJECTS)
        .map_err(|_| json!({"_tag":"Unavailable","reason":"missing-permissions","detail":"Unlock Windows and reconnect to the interactive desktop."}))?;
    let thread_desktop = GetThreadDesktop(GetCurrentThreadId());
    let name = |desktop: HDESK| -> Option<Vec<u16>> {
        let mut buffer = [0u16; 256];
        let mut needed = 0;
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            std::mem::size_of_val(&buffer) as u32,
            Some(&mut needed),
        )
        .ok()?;
        Some(buffer[..buffer.iter().position(|unit| *unit == 0)?].to_vec())
    };
    let matches = thread_desktop
        .ok()
        .and_then(name)
        .zip(name(desktop))
        .is_some_and(|(a, b)| a == b);
    let _ = CloseDesktop(desktop);
    if matches {
        Ok(())
    } else {
        Err(blocked("system-ui"))
    }
}
pub(super) unsafe fn session_connected() -> bool {
    use windows::Win32::System::RemoteDesktop::*;
    let mut session = 0;
    if ProcessIdToSessionId(std::process::id(), &mut session).is_err() {
        return false;
    }
    let mut buffer = PWSTR::null();
    let mut bytes = 0;
    if WTSQuerySessionInformationW(None, session, WTSConnectState, &mut buffer, &mut bytes).is_err()
    {
        return false;
    }
    let active = !buffer.is_null()
        && bytes as usize >= std::mem::size_of::<WTS_CONNECTSTATE_CLASS>()
        && std::ptr::read_unaligned(buffer.0.cast::<WTS_CONNECTSTATE_CLASS>()) == WTSActive;
    WTSFreeMemory(buffer.0.cast());
    active
}
pub(super) unsafe fn authorize(
    hwnd: HWND,
    request: &Value,
    host: &Value,
    needed: &str,
) -> Result<String, Value> {
    if host["overlayWindowIds"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id.as_u64() == Some(hwnd.0 as u64)))
    {
        return Err(blocked("f5"));
    }
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
