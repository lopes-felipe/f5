use super::*;

pub(super) struct WatchSlot {
    active: AtomicBool,
    window: AtomicU64,
    pid: AtomicU64,
    container_pid: AtomicU64,
    epoch: AtomicU64,
    last_activity: AtomicU64,
    frontmost: AtomicBool,
}
impl WatchSlot {
    pub(super) fn new() -> Self {
        Self {
            active: AtomicBool::new(false),
            window: AtomicU64::new(0),
            pid: AtomicU64::new(0),
            container_pid: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
            last_activity: AtomicU64::new(0),
            frontmost: AtomicBool::new(false),
        }
    }
    fn activity(&self, now: u64) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.last_activity.store(now, Ordering::SeqCst);
    }
}
pub(super) struct Watch {
    owners: HashSet<String>,
    slot: usize,
}
#[derive(Clone)]
pub(super) struct Action {
    app: String,
    before: u64,
    until: Option<Instant>,
}
pub(super) fn now_ms() -> u64 {
    STATE.get().unwrap().started.elapsed().as_millis() as u64 + 1
}
/// Hook-safe, observe-only slots outlive suspended and retired generations.
pub(super) fn physical(window: u64, process: u64, movement: bool) {
    let state = STATE.get().unwrap();
    let now = now_ms();
    for slot in &state.watches {
        if slot.active.load(Ordering::SeqCst)
            && (crate::safety::input_conflicts(
                true,
                movement,
                slot.window.load(Ordering::SeqCst),
                slot.pid.load(Ordering::SeqCst),
                window,
                process,
            ) || (!movement
                && process != 0
                && slot.container_pid.load(Ordering::SeqCst) == process))
        {
            slot.activity(now);
        }
    }
}
unsafe fn refresh(app: &str, slot: &WatchSlot) {
    let window = app_window(app).unwrap_or_default();
    let process = owner(window)
        .map(|(_, process)| process as u64)
        .unwrap_or(0);
    let container = pid(window) as u64;
    if slot.window.swap(window.0 as u64, Ordering::SeqCst) != window.0 as u64
        || slot.pid.load(Ordering::SeqCst) != process
    {
        slot.activity(now_ms());
    }
    slot.pid.store(process, Ordering::SeqCst);
    slot.container_pid.store(container, Ordering::SeqCst);
}
pub(super) fn register(app: &str, owner: &str) -> Result<Value, Value> {
    let state = STATE.get().unwrap();
    if app.is_empty() || owner.is_empty() {
        return Err(fail("Execution"));
    }
    let slot_index = {
        let mut registry = state.watch_owners.lock().unwrap();
        let slot = if let Some(watch) = registry.get(app) {
            watch.slot
        } else {
            let index = state
                .watches
                .iter()
                .position(|slot| !slot.active.load(Ordering::SeqCst))
                .ok_or(
                    json!({"_tag":"Execution","message":"Computer target watch limit reached."}),
                )?;
            state.watches[index].active.store(true, Ordering::SeqCst);
            registry.insert(
                app.to_owned(),
                Watch {
                    owners: HashSet::new(),
                    slot: index,
                },
            );
            index
        };
        registry
            .get_mut(app)
            .unwrap()
            .owners
            .insert(owner.to_owned());
        slot
    };
    unsafe {
        refresh(app, &state.watches[slot_index]);
    }
    readiness(Some(app))
}
pub(super) fn release_watch(app: &str, owner: &str) {
    let state = STATE.get().unwrap();
    let mut registry = state.watch_owners.lock().unwrap();
    if let Some(watch) = registry.get_mut(app) {
        watch.owners.remove(owner);
        if watch.owners.is_empty() {
            state.watches[watch.slot]
                .active
                .store(false, Ordering::SeqCst);
            registry.remove(app);
        }
    }
}
/// Hook-safe: one short uncontended lock per physical (non-injected, non-F5) event.
pub(super) fn observe_physical(event: crate::held::HeldEvent) {
    let state = STATE.get().unwrap();
    state.physical_held.lock().unwrap().observe(event, now_ms());
}
/// Virtual-key codes the user is holding, oldest first. A hold counts only when the hook saw it
/// go down and `GetAsyncKeyState` still reports it; see `crate::held`.
pub(super) fn held_inputs() -> Vec<u16> {
    let state = STATE.get().unwrap();
    let sampled = state.physical_held.lock().unwrap().sample();
    // Async key queries stay outside the lock. Only entries unchanged since this sample are
    // dropped, so a release and re-press in between keeps the new hold.
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    let released: Vec<(u16, u64)> = sampled
        .into_iter()
        .filter(|(code, _)| {
            !crate::held::system_codes(*code, swapped)
                .iter()
                .any(|vk| unsafe { GetAsyncKeyState(i32::from(*vk)) } < 0)
        })
        .collect();
    let held = state
        .physical_held
        .lock()
        .unwrap()
        .held(now_ms(), &released);
    let mut reported = state.reported_held.lock().unwrap();
    if *reported != held {
        // One diagnostic per transition, so a stuck input can be named without per-beat noise.
        emit(json!({"type":"heldInput","heldInputs":held_diagnostics(&held)}));
        reported.clone_from(&held);
    }
    held
}
pub(super) fn held_diagnostics(held: &[u16]) -> Vec<Value> {
    held.iter()
        .map(|code| crate::held::diagnostic(*code))
        .collect()
}
pub(super) fn readiness(app: Option<&str>) -> Result<Value, Value> {
    let state = STATE.get().unwrap();
    let sequence = state.input_sequence.load(Ordering::SeqCst);
    let last = state.last_input_ms.load(Ordering::SeqCst);
    let age = if last == 0 {
        -1
    } else {
        now_ms().saturating_sub(last) as i64
    };
    let (epoch, activity_age, frontmost) = if let Some(app) = app {
        let index = state
            .watch_owners
            .lock()
            .unwrap()
            .get(app)
            .map(|watch| watch.slot)
            .ok_or(json!({"_tag":"Execution","message":"Computer target is not watched."}))?;
        let slot = &state.watches[index];
        unsafe {
            refresh(app, slot);
        }
        let front = unsafe { owner(GetForegroundWindow()).is_ok_and(|(id, _)| id == app) };
        if slot.frontmost.swap(front, Ordering::SeqCst) != front {
            slot.activity(now_ms());
        }
        let last = slot.last_activity.load(Ordering::SeqCst);
        (
            slot.epoch.load(Ordering::SeqCst),
            if last == 0 {
                -1
            } else {
                now_ms().saturating_sub(last) as i64
            },
            front,
        )
    } else {
        (sequence, age, false)
    };
    let held = held_inputs();
    Ok(
        json!({"activityEpoch":epoch,"lastActivityAgeMs":activity_age,"frontmost":frontmost,
        "monitorHealthy":state.monitors_ready(),"inputSequence":sequence,
        "lastUserInputAgeMs":age,"inputHeld":!held.is_empty(),
        "heldInputs":held_diagnostics(&held)}),
    )
}
pub(super) fn epoch_matches(app: &str, expected: u64) -> bool {
    let state = STATE.get().unwrap();
    let registry = state.watch_owners.lock().unwrap();
    registry
        .get(app)
        .is_some_and(|watch| state.watches[watch.slot].epoch.load(Ordering::SeqCst) == expected)
}
pub(super) fn target_summaries() -> Vec<Value> {
    let state = STATE.get().unwrap();
    let now = now_ms();
    state
        .watch_owners
        .lock()
        .unwrap()
        .iter()
        .map(|(app, watch)| {
            let slot = &state.watches[watch.slot];
            let last = slot.last_activity.load(Ordering::SeqCst);
            json!({"appId":app,"activityEpoch":slot.epoch.load(Ordering::SeqCst),
            "lastActivityAgeMs":if last == 0 {-1} else {now.saturating_sub(last) as i64},
            "frontmost":slot.frontmost.load(Ordering::SeqCst)})
        })
        .collect()
}
pub(super) struct ActionGuard(u64);
pub(super) fn background_action(request: &Value, before: HWND) -> ActionGuard {
    let state = STATE.get().unwrap();
    let mut actions = state.background_actions.lock().unwrap();
    actions.retain(|_, action| action.until.is_none_or(|until| until >= Instant::now()));
    let generation = generation(request);
    actions.insert(
        generation,
        Action {
            app: s(request, "appId").to_owned(),
            before: before.0 as u64,
            until: None,
        },
    );
    ActionGuard(generation)
}
impl Drop for ActionGuard {
    fn drop(&mut self) {
        if let Some(action) = STATE
            .get()
            .unwrap()
            .background_actions
            .lock()
            .unwrap()
            .get_mut(&self.0)
        {
            action.until = Some(Instant::now() + Duration::from_millis(500));
        }
    }
}
unsafe extern "system" fn foreground_event(
    _: HWINEVENTHOOK,
    _: u32,
    window: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    let state = STATE.get().unwrap();
    let Ok((app, process)) = owner(window) else {
        // Unknown foreground ownership cannot be treated as ordinary user contention.
        for slot in &state.controls {
            let generation = slot.generation.load(Ordering::SeqCst);
            if generation != 0 && !slot.paused.swap(true, Ordering::SeqCst) {
                suspend_generation(Some(generation));
                emit(
                    json!({"type":"targetInterrupted","executionGeneration":generation,"cause":"unresolved"}),
                );
            }
        }
        return;
    };
    {
        let registry = state.watch_owners.lock().unwrap();
        for (id, watch) in registry.iter() {
            let slot = &state.watches[watch.slot];
            let front = *id == app;
            if slot.frontmost.swap(front, Ordering::SeqCst) != front {
                slot.activity(now_ms());
            }
            if front {
                slot.pid.store(process as u64, Ordering::SeqCst);
                slot.window.store(window.0 as u64, Ordering::SeqCst);
                slot.container_pid
                    .store(pid(window) as u64, Ordering::SeqCst);
            }
        }
    }
    let incidents: Vec<_> = state
        .background_actions
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, action)| {
            action.app == app
                && action.before != window.0 as u64
                && action.until.is_none_or(|until| until >= Instant::now())
        })
        .map(|(generation, _)| *generation)
        .collect();
    // Attribute every matching action before classifying any activation as user activity.
    for generation in &incidents {
        suspend_generation(Some(*generation));
        emit(json!({"type":"activationIncident","executionGeneration":generation,"appId":app}));
    }
    for slot in &state.controls {
        let generation = slot.generation.load(Ordering::SeqCst);
        if generation != 0
            && slot.background.load(Ordering::SeqCst)
            && (slot.pid.load(Ordering::SeqCst) == process as u64
                || slot.container_pid.load(Ordering::SeqCst) == pid(window) as u64)
            && !slot.paused.load(Ordering::SeqCst)
        {
            slot.input_cause.store(6, Ordering::SeqCst);
            slot.paused.store(true, Ordering::SeqCst);
            suspend_generation(Some(generation));
            emit(
                json!({"type":"targetInterrupted","executionGeneration":generation,"appId":app,"cause":"frontmost"}),
            );
        }
    }
}
pub(super) fn start() {
    std::thread::spawn(|| unsafe {
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(foreground_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        let state = STATE.get().unwrap();
        state
            .foreground_hook_installed
            .store(!hook.0.is_null(), Ordering::SeqCst);
        if hook.0.is_null() {
            return;
        }
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        state
            .foreground_hook_installed
            .store(false, Ordering::SeqCst);
        let _ = UnhookWinEvent(hook);
        suspend(None);
    });
}
