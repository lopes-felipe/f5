import AppKit
import ApplicationServices
import Carbon
import Darwin
import F5ComputerCore
import ScreenCaptureKit

struct Failure: Error {
  let payload: [String: Any]
  init(_ tag: String, _ key: String? = nil, _ value: Any? = nil,
    captureFailure: [String: Any]? = nil) {
    var payload: [String: Any] = ["_tag": tag]
    if let key, let value { payload[key] = value }
    if let captureFailure { payload["captureFailure"] = captureFailure }
    if tag == "Unavailable", key == "reason", value as? String == "missing-permissions" {
      let missing =
        (CGPreflightScreenCaptureAccess() ? [] : ["screen-recording"])
        + (AXIsProcessTrusted() ? [] : ["accessibility"])
      payload["missing"] = missing.isEmpty ? ["screen-recording"] : missing
    }
    self.payload = payload
  }
}
let outputLock = NSLock()
let outputQueue = DispatchQueue(label: "f5.computer.output")
let outputSlots = DispatchSemaphore(value: 32)
func emit(_ message: [String: Any]) {
  guard let bytes = encodeComputerPacket(message) else {
    permits.suspendAll()
    return
  }
  guard outputSlots.wait(timeout: .now()) == .success else {
    permits.suspendAll()
    return
  }
  outputQueue.async {
    defer { outputSlots.signal() }
    outputLock.withLock {
      FileHandle.standardOutput.write(bytes)
      FileHandle.standardOutput.write(Data([10]))
    }
  }
}
let statusLock = NSLock()
var lastStatus: NSDictionary?
func emitStatus(_ status: [String: Any]) {
  statusLock.withLock {
    let current = status as NSDictionary
    if lastStatus?.isEqual(current) == true { return }
    lastStatus = current
    emit(["type": "status", "status": status])
  }
}
func string(_ object: [String: Any], _ key: String) -> String { object[key] as? String ?? "" }
func integer(_ object: [String: Any], _ key: String) -> Int {
  (object[key] as? NSNumber)?.intValue ?? 0
}
func number(_ object: [String: Any], _ key: String) -> Double {
  (object[key] as? NSNumber)?.doubleValue ?? 0
}
func applicationElement(_ pid: pid_t) -> AXUIElement {
  let root = AXUIElementCreateApplication(pid)
  _ = AXUIElementSetMessagingTimeout(root, 0.25)
  _ = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  _ = AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  return root
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
    return nil
  }
  return value
}
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
  guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(value, to: AXUIElement.self)
}
func axRect(_ element: AXUIElement) -> CGRect? {
  guard let position = attribute(element, kAXPositionAttribute),
    let size = attribute(element, kAXSizeAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
    CFGetTypeID(size) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var dimensions = CGSize.zero
  guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
    AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions)
  else { return nil }
  return CGRect(origin: point, size: dimensions)
}
/// Reads one element for the secure-field audit in a single AX round trip.
func secureAuditNode(
  _ element: AXUIElement, diagnostics: ComputerSecureAuditDiagnostics? = nil
) -> ComputerSecureAuditNode<AXUIElement>? {
  let started = ProcessInfo.processInfo.systemUptime
  defer {
    diagnostics?.nodeReadDuration(seconds: ProcessInfo.processInfo.systemUptime - started)
  }
  var values: CFArray?
  let status = AXUIElementCopyMultipleAttributeValues(
    element, computerSecureAuditAttributes, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
  guard status == .success,
    let list = values as [AnyObject]?
  else {
    if status != .success { diagnostics?.axFailure(.nodeRead, error: Int(status.rawValue)) }
    return nil
  }
  if list.count == 5 {
    if CFGetTypeID(list[4]) == CFArrayGetTypeID() {
      diagnostics?.observedChildren(CFArrayGetCount(unsafeBitCast(list[4], to: CFArray.self)))
    }
    for (index, operation) in [
      (0, ComputerSecureAuditDiagnostics.Operation.role), (1, .subrole), (4, .children),
    ] {
      if let error = computerAXBatchError(list[index]),
        error != .attributeUnsupported && error != .noValue
      {
        diagnostics?.axFailure(operation, error: Int(error.rawValue))
      }
    }
  }
  return computerSecureAuditNode(list)
}
func secureAuditSearch(
  _ root: AXUIElement, expired: () -> Bool, diagnostics: ComputerSecureAuditDiagnostics
) -> [AXUIElement]? {
  computerSearchWebArea(root: root, expired: expired, diagnostics: diagnostics) { element, key in
    let started = ProcessInfo.processInfo.systemUptime
    defer {
      diagnostics.searchDuration(seconds: ProcessInfo.processInfo.systemUptime - started)
    }
    var value: CFTypeRef?
    let predicate: [String: Any] = [
      "AXSearchKey": key, "AXResultsLimit": 5000, "AXDirection": "AXDirectionNext",
      "AXImmediateDescendantsOnly": false, "AXVisibleOnly": false,
    ]
    let status = AXUIElementCopyParameterizedAttributeValue(
      element, "AXUIElementsForSearchPredicate" as CFString, predicate as CFDictionary, &value)
    guard status == .success else {
      diagnostics.axFailure(
        key == "AXTextFieldSearchKey" ? .textFields : .frames, error: Int(status.rawValue))
      return nil
    }
    guard let results = value as? [AXUIElement] else {
      diagnostics.invalidSearchResult()
      return nil
    }
    return results
  }
}
private typealias AXWindowIDFunction =
  @convention(c) (
    AXUIElement, UnsafeMutablePointer<CGWindowID>
  ) -> AXError
private let axWindowIDFunction: AXWindowIDFunction? = {
  guard let handle = dlopen(nil, RTLD_LAZY) else { return nil }
  defer { dlclose(handle) }
  guard let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return nil }
  return unsafeBitCast(symbol, to: AXWindowIDFunction.self)
}()
/// Resolve the private C entry point optionally; unavailable symbols use frame matching.
func windowIdentifier(_ element: AXUIElement) -> CGWindowID? {
  var id: CGWindowID = 0
  return axWindowIDFunction?(element, &id) == .success && id != 0 ? id : nil
}
func tier(_ id: String) -> String { computerAppTier(id) }
func browser(_ id: String) -> Bool { computerAppIsBrowser(id) }
struct Display {
  let id: CGDirectDisplayID
  let bounds: CGRect
  let pixelWidth: Int
  let pixelHeight: Int
  let width: Int
  let height: Int
  let generation: String
  init(_ id: CGDirectDisplayID) {
    self.id = id
    bounds = CGDisplayBounds(id)
    pixelWidth = CGDisplayCopyDisplayMode(id)?.pixelWidth ?? CGDisplayPixelsWide(id)
    pixelHeight = CGDisplayCopyDisplayMode(id)?.pixelHeight ?? CGDisplayPixelsHigh(id)
    (width, height) = modelSize(width: pixelWidth, height: pixelHeight)
    generation =
      "\(id):\(bounds.origin.x):\(bounds.origin.y):\(bounds.width):\(bounds.height):\(pixelWidth):\(pixelHeight):\(CGDisplayRotation(id))"
  }
  var json: [String: Any] {
    [
      "displayId": String(id), "geometryGeneration": generation, "primary": id == CGMainDisplayID(),
      "nativeBounds": [
        "x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height,
      ], "pixelSize": ["width": pixelWidth, "height": pixelHeight],
      "rotation": CGDisplayRotation(id), "modelSize": ["width": width, "height": height],
    ]
  }
  func point(_ x: Int, _ y: Int) throws -> CGPoint {
    guard x >= 0 && y >= 0 && x < width && y < height else { throw Failure("GeometryChanged") }
    return CGPoint(
      x: bounds.minX + (Double(x) + 0.5) * bounds.width / Double(width),
      y: bounds.minY + (Double(y) + 0.5) * bounds.height / Double(height))
  }
}
func displays() -> [Display] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 32)
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(32, &ids, &count) == .success else { return [] }
  return ids.prefix(Int(count)).map(Display.init)
}
func display(_ id: String) throws -> Display {
  let current = displays()
  if id.isEmpty && current.count == 1 { return current[0] }
  guard let match = current.first(where: { String($0.id) == id }) else {
    throw Failure("GeometryChanged")
  }
  return match
}
// Background accessibility delivery is always advertised; Electron's preview gate decides
// whether a session may use it.
let helperCapabilities: [String] = ["background-ax-v1", "computer-cooperation-v1", "background-shared-app-v1", "background-events-v1"]
/// Per-generation permits. Lock order: never hold `permits`' lock with any other lock.
let permits = ExecutionPermits()
/// Guards grants, scopes' target PIDs, the window cache, frontmost PID, input sequence, the
/// in-flight table, per-app queues and the activation-prone set. Never held across AX,
/// CGWindowList or emit calls.
let stateLock = NSLock()
var latestGrants: [String: [String: Any]] = [:]
var pressedKeys = HeldComputerInputs<CGKeyCode>()
var pressedButtons = HeldComputerInputs<Int>()
let inputLock = NSRecursiveLock()
let inputQueue = DispatchQueue(label: "f5.computer.input")
/// Held-input release never runs synchronously inside the event tap callback.
let releaseQueue = DispatchQueue(label: "f5.computer.release")
/// Resolves actionable physical input against background targets, off the tap callback.
let conflictQueue = DispatchQueue(label: "f5.computer.conflicts")
let telemetryQueue = DispatchQueue(label: "f5.computer.telemetry")
let observeQueue = OperationQueue()
observeQueue.maxConcurrentOperationCount = 2
var eventTap: CFMachPort?
struct CachedWindow {
  let pid: Int
  let bounds: CGRect
}
struct ActionableInput {
  let kind: ComputerInputKind
  let location: CGPoint
  let windowNumber: Int
  let sequence: Int
  let frontmostPid: Int?
}
struct TrackedAction {
  let generation: Int
  let appId: String
  let targetPid: Int
  let beforeFrontPid: Int?
  let dispatchSequence: Int
  var windowEnd: TimeInterval
  let session: String
}
// All guarded by stateLock.
var windowCache: [Int: CachedWindow] = [:]
var windowCacheRefreshedAt: TimeInterval = 0
var frontmostPid: Int?
var frontmostBundleId: String?
var lastInputUptime: TimeInterval = 0
var inputSequence = 0
var targetWatches: [String: ComputerTargetWatch] = [:]
var postedRequests = Set<String>()
var pendingSettleDeadline: TimeInterval = 0
var pendingInputs: [ActionableInput] = []
var enqueuedInputSequence = 0
var resolvedInputSequence = 0
var inFlight: [String: Int] = [:]
var inFlightByGeneration: [Int: Int] = [:]
var appQueues: [String: DispatchQueue] = [:]
var activationProne = Set<String>()
var trackedActions: [String: TrackedAction] = [:]
var cancelledRequests: [String] = []
var lastIdleTelemetry: TimeInterval = 0
func locked<T>(_ body: () throws -> T) rethrows -> T {
  stateLock.lock()
  defer { stateLock.unlock() }
  return try body()
}
func appQueue(_ appId: String) -> DispatchQueue {
  locked {
    if let queue = appQueues[appId] { return queue }
    let queue = DispatchQueue(label: "f5.computer.app.\(appQueues.count)")
    appQueues[appId] = queue
    return queue
  }
}
func requestCancelled(_ id: String) -> Bool { locked { cancelledRequests.contains(id) } }
private var monitorHealthyValue = false
var monitorHealthy: Bool {
  get {
    stateLock.lock()
    defer { stateLock.unlock() }
    return monitorHealthyValue
  }
  set {
    stateLock.lock()
    monitorHealthyValue = newValue
    stateLock.unlock()
  }
}
var lastPhysicalPoint: CGPoint?
var physicalWindowStarted = ProcessInfo.processInfo.systemUptime
var installed: [String: URL] = [:]
let catalogLock = NSLock()
struct Snapshot {
  let id: String
  let pid: pid_t
  let launchDate: Date?
  let bundleURL: URL?
  let window: AXUIElement
  let document: String?
  let elements: [String: AXUIElement]
  let roles: [String: String]
  /// Owner, session, grant version and delivery the snapshot was taken under.
  let owner: String
  let session: String
  let grantVersion: Int
  let delivery: String
}
var snapshots: [String: [Snapshot]] = [:]
let snapshotLock = NSLock()
func releaseHeldInput(where matches: ((HeldComputerInputOwner) -> Bool)? = nil) {
  inputLock.lock()
  defer { inputLock.unlock() }
  let keys = matches.map { pressedKeys.drain(where: $0) } ?? pressedKeys.drain()
  for key in keys {
    if let event = computerKeyboardEvent(keyCode: key, keyDown: false) {
      event.post(tap: .cghidEventTap)
    }
  }
  let location = CGEvent(source: nil)?.location ?? .zero
  let buttons = matches.map { pressedButtons.drain(where: $0) } ?? pressedButtons.drain()
  for button in buttons {
    let b: CGMouseButton = button == 1 ? .right : button == 2 ? .center : .left
    let t: CGEventType = button == 1 ? .rightMouseUp : button == 2 ? .otherMouseUp : .leftMouseUp
    if let event = CGEvent(
      mouseEventSource: nil, mouseType: t, mouseCursorPosition: location, mouseButton: b)
    {
      event.flags = []
      event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
      event.post(tap: .cghidEventTap)
    }
  }
}
func suspend(_ event: String? = nil, synchronous: Bool = false) {
  // Local recognition time, before waiting to release held input. Certification
  // fixtures compare this with AppKit event/delivery times, never text or key data.
  let recognizedAtMs = ProcessInfo.processInfo.systemUptime * 1000
  permits.suspendAll()
  if synchronous { releaseHeldInput() } else { releaseQueue.async { releaseHeldInput() } }
  if let event {
    telemetryQueue.async { emit(["type": event, "recognizedAtMs": recognizedAtMs]) }
  }
}
/// Tap-callback state; only touched on the main run loop.
var dragging = false
/// Suspend every active generation and tell Electron which ones stopped.
func suspendAllReporting() {
  let active = permits.activeGenerations()
  permits.suspendAll()
  releaseQueue.async { releaseHeldInput() }
  for (generation, scope) in active {
    interrupt(
      generation,
      scope.isBackground
        ? ["type": "targetInterrupted", "cause": "monitor"] : ["type": "physicalInput", "cause": "monitor"])
  }
}
/// Suspend one generation locally, then report it asynchronously.
func interrupt(_ generation: Int, _ message: [String: Any]) {
  permits.suspend(generation, cause: message["cause"] as? String)
  releaseQueue.async { releaseHeldInput(where: { $0.generation == generation }) }
  var payload = message
  payload["executionGeneration"] = generation
  payload["recognizedAtMs"] = ProcessInfo.processInfo.systemUptime * 1000
  telemetryQueue.async { emit(payload) }
}
/// Window → PID/bounds map for on-screen windows. Never called from the tap callback.
func refreshWindowCache() {
  var cache: [Int: CachedWindow] = [:]
  for record in windows() {
    guard let rect = windowRect(record) else { continue }
    cache[integer(record, kCGWindowNumber as String)] = CachedWindow(
      pid: integer(record, kCGWindowOwnerPID as String), bounds: rect)
  }
  let front = NSWorkspace.shared.frontmostApplication
  let watched = locked { Array(targetWatches.keys) }
  let identities = Dictionary(uniqueKeysWithValues: watched.map { ($0, pids(for: $0)) })
  locked {
    windowCache = cache
    windowCacheRefreshedAt = ProcessInfo.processInfo.systemUptime
    frontmostPid = front.map { Int($0.processIdentifier) }
    frontmostBundleId = front?.bundleIdentifier
    for appId in watched {
      targetWatches[appId]?.identity(pids: identities[appId] ?? [],
        frontmost: front?.bundleIdentifier == appId, now: ProcessInfo.processInfo.systemUptime)
    }
  }
}
func backgroundScopesActive() -> [Int: String] {
  var result: [Int: String] = [:]
  for (generation, scope) in permits.activeGenerations() {
    if case .app(let appId) = scope { result[generation] = appId }
  }
  return result
}
func pids(for appId: String) -> Set<Int> {
  Set(
    NSRunningApplication.runningApplications(withBundleIdentifier: appId).map {
      Int($0.processIdentifier)
    })
}
/// Keys, modifiers and buttons the hardware currently holds. The HID system state excludes
/// posted events, so a synthetic keydown whose keyup never arrived (ours or another process's)
/// cannot block a foreground takeover while nobody touches the keyboard or mouse. Agent events
/// come from a private-state source. Side effect: input that arrives as software events (Screen
/// Sharing, Universal Control, accessibility drivers) no longer counts as held, so a remote user
/// holding a drag still for longer than the idle dwell does not block a takeover.
func physicalInputHeld() -> Bool {
  let state = CGEventSourceStateID.hidSystemState
  if !CGEventSource.flagsState(state).intersection([.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]).isEmpty {
    return true
  }
  return (0..<256).contains { CGEventSource.keyState(state, key: CGKeyCode($0)) }
    || (0..<32).contains { CGEventSource.buttonState(state, button: CGMouseButton(rawValue: UInt32($0))!) }
}
func targetReadiness(_ appId: String?) -> [String: Any] {
  let healthy = monitorHealthy
  let held = physicalInputHeld()
  return locked {
    let now = ProcessInfo.processInfo.systemUptime
    let watch = appId.flatMap { targetWatches[$0] }
    return [
      "activityEpoch": watch?.activityEpoch ?? inputSequence,
      "lastActivityAgeMs": watch?.activityAgeMs(now: now) ?? (lastInputUptime > 0 ? Int((now - lastInputUptime) * 1000) : -1),
      "frontmost": watch?.frontmost ?? false, "monitorHealthy": healthy,
      "inputSequence": inputSequence,
      "lastUserInputAgeMs": lastInputUptime > 0 ? Int((now - lastInputUptime) * 1000) : -1,
      "inputHeld": held,
    ]
  }
}
func hasTargetWatches() -> Bool { locked { !targetWatches.isEmpty } }
/// Resolve queued physical input against every active background target.
func resolveInputs() {
  let (events, cache, fresh, front) = locked {
    () -> ([ActionableInput], [Int: CachedWindow], Bool, Int?) in
    let drained = pendingInputs
    pendingInputs.removeAll()
    return (
      drained, windowCache,
      ProcessInfo.processInfo.systemUptime - windowCacheRefreshedAt < 0.5, frontmostPid
    )
  }
  guard !events.isEmpty else { return }
  let targets = backgroundScopesActive()
  let appIds = Set(targets.values).union(locked { Set(targetWatches.keys) })
  var targetPids: [String: Set<Int>] = [:]
  for appId in appIds { targetPids[appId] = pids(for: appId) }
  let primaryHeight = CGDisplayBounds(CGMainDisplayID()).height
  for event in events {
    var ownerAtPoint: Int?
    if !appIds.isEmpty {
      let point = computerAppKitCoordinates(
        x: event.location.x, y: event.location.y, primaryDisplayHeight: primaryHeight)
      let hit: () -> Int = {
        NSWindow.windowNumber(
          at: NSPoint(x: point.x, y: point.y), belowWindowWithWindowNumber: 0)
      }
      let windowId = Thread.isMainThread ? hit() : DispatchQueue.main.sync(execute: hit)
      ownerAtPoint = cache[windowId]?.pid
    }
    for appId in appIds {
      let owned = targetPids[appId] ?? []
      let bounds = cache.values.filter { owned.contains($0.pid) }.map(\.bounds)
      if computerInputConflicts(
        kind: event.kind, location: event.location,
        eventWindowOwnerPid: event.windowNumber > 0 ? cache[event.windowNumber]?.pid : nil,
        cachedOwnerAtPoint: ownerAtPoint, frontmostPid: event.frontmostPid, targetPids: owned,
        targetBounds: bounds, cacheFresh: fresh)
      {
        locked { targetWatches[appId]?.activity(now: ProcessInfo.processInfo.systemUptime) }
        let cause: String = switch event.kind {
          case .keyDown: "key"
          case .scroll: "scroll"
          case .dragStart, .drop: "drag"
          default: "pointer"
        }
        for (generation, target) in targets where target == appId {
          interrupt(generation, ["type": "targetInterrupted", "appId": appId, "cause": cause])
        }
      }
    }
    locked { resolvedInputSequence = max(resolvedInputSequence, event.sequence) }
  }
}
func permissions() -> [String: Any] {
  let screen = CGPreflightScreenCaptureAccess()
  let accessibility = AXIsProcessTrusted()
  let missing = (screen ? [] : ["screen-recording"]) + (accessibility ? [] : ["accessibility"])
  if !missing.isEmpty {
    return ["available": false, "reason": "missing-permissions", "missing": missing]
  }
  if !monitorHealthy { return ["available": false, "reason": "monitor-unhealthy"] }
  return [
    "available": true, "displays": displays().map(\.json),
    "passwordMaskingSupported": true,
  ]
}
func installMonitor() {
  guard AXIsProcessTrusted() else {
    monitorHealthy = false
    return
  }
  let types: [CGEventType] = [
    .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
    .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged,
    .scrollWheel,
  ]
  let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
  eventTap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
    eventsOfInterest: mask,
    callback: { _, type, event, _ in
      // Bounded work only: recognise the chord, stamp input, queue actionable events.
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // Never auto-resume: everything stays suspended until Electron re-arms it.
        suspendAllReporting()
        monitorHealthy = false
        if let tap = eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
      }
      if event.getIntegerValueField(.eventSourceUserData) == 0xF5C0 {
        return Unmanaged.passUnretained(event)
      }
      let flags = event.flags
      if type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53
        && flags.contains(.maskControl) && flags.contains(.maskCommand)
      {
        suspend("killSwitch")
        return Unmanaged.passUnretained(event)
      }
      let now = ProcessInfo.processInfo.systemUptime
      var significant = true
      if type == .mouseMoved {
        if now - physicalWindowStarted > 0.25 {
          lastPhysicalPoint = event.location
          physicalWindowStarted = now
        }
        significant =
          lastPhysicalPoint.map {
            hypot(event.location.x - $0.x, event.location.y - $0.y) > 8
          } ?? false
      }
      let kind: ComputerInputKind? =
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown: .pointerDown
        case .keyDown: .keyDown
        case .scrollWheel: .scroll
        case .leftMouseDragged, .rightMouseDragged: .dragStart
        case .leftMouseUp, .rightMouseUp: dragging ? .drop : nil
        default: nil
        }
      if type == .leftMouseDragged || type == .rightMouseDragged { dragging = true }
      if type == .leftMouseUp || type == .rightMouseUp || type == .leftMouseDown { dragging = false }
      var overflow = false
      let queued: Bool = locked {
        if significant {
          lastInputUptime = now
          inputSequence += 1
        }
        guard let kind else { return false }
        if kind == .scroll || kind == .dragStart, let last = pendingInputs.last, last.kind == kind,
          hypot(last.location.x - event.location.x, last.location.y - event.location.y) < 20
        {
          return false
        }
        guard pendingInputs.count < 256 else {
          overflow = true
          return false
        }
        enqueuedInputSequence = inputSequence
        pendingInputs.append(
          ActionableInput(
            kind: kind, location: event.location,
            windowNumber: Int(event.getIntegerValueField(.mouseEventWindowUnderMousePointer)),
            sequence: inputSequence, frontmostPid: frontmostPid))
        return true
      }
      if overflow {
        // Unresolvable input: background generations cannot prove the user is elsewhere.
        for generation in permits.suspendBackground() {
          interrupt(generation, ["type": "targetInterrupted", "cause": "input-overflow"])
        }
      }
      if queued { conflictQueue.async { resolveInputs() } }
      // Foreground and takeover generations share the pointer and keyboard: any input pauses.
      if significant {
        let cause = type == .mouseMoved ? "move"
          : type == .scrollWheel ? "scroll"
          : type == .keyDown || type == .keyUp || type == .flagsChanged ? "key"
          : type == .leftMouseDragged || type == .rightMouseDragged ? "drag" : "pointer"
        let foreground = permits.suspendForeground(cause: cause)
        for generation in foreground {
          interrupt(generation, ["type": "physicalInput", "cause": cause])
        }
        if foreground.isEmpty && now - lastIdleTelemetry >= 0.1 {
          // Coalesced idle telemetry: never pauses background holders.
          lastIdleTelemetry = now
          telemetryQueue.async { emit(["type": "physicalInput", "idle": true]) }
        }
      }
      return Unmanaged.passUnretained(event)
    }, userInfo: nil)
  guard let tap = eventTap, let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  else {
    monitorHealthy = false
    return
  }
  CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  monitorHealthy = CGEvent.tapIsEnabled(tap: tap)
}
func authorization(_ request: [String: Any]) -> [String: Any] {
  request["authorization"] as? [String: Any] ?? [:]
}
func delivery(_ request: [String: Any]) -> String {
  string(request, "delivery") == "background" ? "background" : "foreground"
}
func isBackground(_ request: [String: Any]) -> Bool { delivery(request) == "background" }
func checkPermit(_ request: [String: Any]) throws {
  let auth = authorization(request)
  let generation = integer(auth, "executionGeneration")
  guard permits.authorized(generation, id: string(request, "requestId"))
  else {
    let cause = permits.interruptionCause(generation) ?? ""
    throw Failure("Interrupted", "cause",
      ["pointer", "key", "scroll", "drag", "move", "frontmost"].contains(cause) ? "user-input" : "permit-expired")
  }
  // The generation's immutable scope decides what this request may do.
  guard let scope = permits.scope(generation) else {
    throw Failure("Interrupted", "cause", "permit-expired")
  }
  let op = string(request, "op")
  let appId = request["appId"] as? String
  if !computerScopeAllows(
    scope: scope, delivery: delivery(request), op: op, appId: appId,
    action: request["action"] as? String)
  {
    if case .takeover = scope, !isBackground(request) {
      throw Failure("TargetBlocked", "kind", "other-app")
    }
    if isBackground(request), case .app(let scoped) = scope, appId != scoped {
      throw Failure("ReplayRejected")
    }
    throw Failure("ForegroundRequired", "reason", "unsupported-in-background")
  }
  guard Date().timeIntervalSince1970 * 1000 < number(request, "deadlineAtMs") else {
    throw Failure("Interrupted", "cause", "permit-expired")
  }
  guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
    throw Failure("Unavailable", "reason", "missing-permissions")
  }
  guard monitorHealthy else { throw Failure("Unavailable", "reason", "monitor-unhealthy") }
  if let expected = request["activityEpoch"] as? Int, let appId {
    guard locked({ targetWatches[appId]?.activityEpoch == expected }) else {
      throw Failure("Interrupted", "cause", "user-input")
    }
  }
  if let expected = request["inputSequence"] as? Int,
    locked({ inputSequence }) != expected {
    throw Failure("Interrupted", "cause", "user-input")
  }
  try checkGrants(request)
}
func checkGrants(_ request: [String: Any]) throws {
  let auth = authorization(request)
  let key = string(auth, "profileId") + "\0" + string(auth, "threadId")
  stateLock.lock()
  let latest = latestGrants[key]
  stateLock.unlock()
  guard let latest, string(latest, "sessionGeneration") == string(auth, "sessionGeneration"),
    integer(latest, "grantVersion") == integer(auth, "grantVersion"),
    NSArray(array: latest["grants"] as? [[String: Any]] ?? []).isEqual(
      to: auth["grants"] as? [[String: Any]] ?? [])
  else { throw Failure("Interrupted", "cause", "access-changed") }
}
func grant(_ app: NSRunningApplication, request: [String: Any], host: [String: Any], needed: String)
  throws -> String
{
  if let kind = computerTargetBlock(
    appId: app.bundleIdentifier, pid: Int(app.processIdentifier),
    f5Pids: host["f5Pids"] as? [Int] ?? [],
    helperPid: Int(ProcessInfo.processInfo.processIdentifier))
  {
    throw Failure("TargetBlocked", "kind", kind)
  }
  guard let id = app.bundleIdentifier else {
    throw Failure("TargetBlocked", "kind", "owner-unknown")
  }
  let appTier = tier(id)
  let grants = authorization(request)["grants"] as? [[String: Any]] ?? []
  guard let access = grants.first(where: { string($0, "appId") == id }),
    string(access, "tier") == appTier
  else { throw Failure("NotGranted", "needed", needed) }
  guard
    allowsComputerGrant(
      tier: appTier, allowTyping: access["allowTyping"] as? Bool == true, needed: needed)
  else { throw Failure("NotGranted", "needed", needed) }
  // A takeover is foreground limited to one app: every recipient must belong to it.
  if needed != "view",
    case .takeover(let scoped) = permits.scope(
      integer(authorization(request), "executionGeneration")),
    scoped != id
  {
    throw Failure("TargetBlocked", "kind", "other-app")
  }
  return id
}
func windows() -> [[String: Any]] {
  CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    as? [[String: Any]] ?? []
}
func windowRect(_ record: [String: Any]) -> CGRect? {
  guard let bounds = record[kCGWindowBounds as String] as? [String: Any] else { return nil }
  return CGRect(dictionaryRepresentation: bounds as CFDictionary)
}
func focused(_ request: [String: Any], _ host: [String: Any], needed: String) throws -> (
  NSRunningApplication, AXUIElement, AXUIElement
) {
  guard let app = NSWorkspace.shared.frontmostApplication else {
    throw Failure("TargetBlocked", "kind", "focus-unknown")
  }
  if let requested = request["appId"] as? String, requested != app.bundleIdentifier {
    throw Failure("TargetBlocked", "kind", "other-app")
  }
  _ = try grant(app, request: request, host: host, needed: needed)
  let root = applicationElement(app.processIdentifier)
  _ = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  _ = AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  guard let element = axElement(attribute(root, kAXFocusedUIElementAttribute)),
    let window = axElement(attribute(root, kAXFocusedWindowAttribute))
  else { throw Failure("TargetBlocked", "kind", "focus-unknown") }
  var pid: pid_t = 0
  let knownPid = AXUIElementGetPid(element, &pid) == .success
  if let kind = computerFocusBlock(
    frontPid: Int(app.processIdentifier), focusedPid: knownPid ? Int(pid) : nil,
    secureInput: IsSecureEventInputEnabled(), role: attribute(element, kAXRoleAttribute) as? String,
    subrole: attribute(element, kAXSubroleAttribute) as? String)
  {
    throw Failure("TargetBlocked", "kind", kind)
  }
  return (app, element, window)
}
func authorizePoint(_ point: CGPoint, request: [String: Any], host: [String: Any]) throws {
  try checkPermit(request)
  if !string(request, "geometryGeneration").isEmpty {
    guard let current = displays().first(where: { String($0.id) == string(request, "displayId") }),
      current.generation == string(request, "geometryGeneration")
    else { throw Failure("GeometryChanged") }
  }
  if let app = NSWorkspace.shared.frontmostApplication {
    let root = applicationElement(app.processIdentifier)
    if let bar = axElement(attribute(root, kAXMenuBarAttribute)), let bounds = axRect(bar),
      point.y >= bounds.minY && point.y < bounds.maxY
    {
      let items = attribute(bar, kAXChildrenAttribute) as? [AXUIElement] ?? []
      guard computerMenuPointAllowed(x: point.x, y: point.y, items: items.map(axRect)) else {
        throw Failure("TargetBlocked", "kind", "system-ui")
      }
      _ = try grant(app, request: request, host: host, needed: "click")
      return
    }
  }
  // This is the WindowServer's actual mouse-down hit test. Rectangles alone
  // include transparent Dock surfaces, click-through overlays and window corners.
  let coordinates = computerAppKitCoordinates(
    x: point.x, y: point.y, primaryDisplayHeight: CGDisplayBounds(CGMainDisplayID()).height)
  let appKitPoint = NSPoint(x: coordinates.x, y: coordinates.y)
  let hit: () -> Int = {
    NSWindow.windowNumber(at: appKitPoint, belowWindowWithWindowNumber: 0)
  }
  let windowId = Thread.isMainThread ? hit() : DispatchQueue.main.sync(execute: hit)
  var owners: [Int: Int] = [:]
  for record in windows() {
    owners[integer(record, kCGWindowNumber as String)] = integer(
      record, kCGWindowOwnerPID as String)
  }
  guard
    let pid = computerRecipientPid(
      windowId: windowId, owners: owners, overlayWindowIds: host["overlayWindowIds"] as? [Int] ?? []
    ),
    let app = NSRunningApplication(processIdentifier: pid_t(pid))
  else { throw Failure("TargetBlocked", "kind", "owner-unknown") }
  _ = try grant(app, request: request, host: host, needed: "click")
}
func postMouse(
  _ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, request: [String: Any],
  host: [String: Any], clickCount: Int = 1, flags: CGEventFlags = []
) throws {
  try authorizePoint(point, request: request, host: host)
  inputLock.lock()
  defer { inputLock.unlock() }
  guard
    let event = CGEvent(
      mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  else { throw Failure("Execution", "message", "Unable to create input event.") }
  event.flags = flags
  event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
  event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
  try checkPermit(request)
  if [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) {
    pressedButtons.insert(Int(button.rawValue), owner: inputOwner(request))
  }
  postActionEvent(event, request)
  if [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) {
    pressedButtons.remove(Int(button.rawValue))
  }
}
func markActionStarted(_ request: [String: Any]) {
  locked { _ = postedRequests.insert(string(request, "requestId")) }
}
func postActionEvent(_ event: CGEvent, _ request: [String: Any]) {
  markActionStarted(request)
  event.post(tap: .cghidEventTap)
}
func appRecord(_ app: NSRunningApplication) -> [String: Any]? {
  guard let id = app.bundleIdentifier else { return nil }
  var record: [String: Any] = [
    "appId": id, "name": String((app.localizedName ?? id).prefix(200)), "running": true,
    "frontmost": app.isActive, "tier": tier(id),
  ]
  if browser(id) { record["warning"] = "browser" }
  return record
}
func protectAppRecords(_ records: [[String: Any]], _ host: [String: Any]) -> [[String: Any]] {
  let ids = Set(
    NSWorkspace.shared.runningApplications.filter {
      (host["f5Pids"] as? [Int] ?? []).contains(Int($0.processIdentifier))
    }.compactMap(\.bundleIdentifier))
  return records.map { record in
    var value = record
    if ids.contains(string(value, "appId")) { value["tier"] = "blocked" }
    return value
  }
}
func listApps() -> [[String: Any]] {
  NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap(
    appRecord)
}
func resolveApps(_ queries: [String]) -> [[String: Any]] {
  catalogLock.lock()
  defer { catalogLock.unlock() }
  var records = listApps()
  var known = Set(records.map { string($0, "appId") })
  for root in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
    guard
      let enumerator = FileManager.default.enumerator(
        at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles])
    else { continue }
    while let url = enumerator.nextObject() as? URL {
      if enumerator.level > 2 {
        enumerator.skipDescendants()
        continue
      }
      if url.pathExtension == "app" {
        enumerator.skipDescendants()
        guard let bundle = Bundle(url: url), let id = bundle.bundleIdentifier else { continue }
        installed[id] = url
        if !known.contains(id) {
          known.insert(id)
          var record: [String: Any] = [
            "appId": id,
            "name": String(
              ((bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? url.deletingPathExtension().lastPathComponent).prefix(200)), "running": false,
            "frontmost": false, "tier": tier(id),
          ]
          if browser(id) { record["warning"] = "browser" }
          records.append(record)
        }
      }
    }
  }
  return records.filter { record in
    queries.contains(where: { query in
      string(record, "appId").caseInsensitiveCompare(query) == .orderedSame
        || string(record, "name").localizedCaseInsensitiveContains(query)
    })
  }.prefix(100).map { $0 }
}
func appById(_ id: String) throws -> NSRunningApplication {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first else {
    throw Failure("Execution", "message", "App is not running.")
  }
  return app
}
func inspect(_ request: [String: Any], _ host: [String: Any]) throws -> [String: Any] {
  let id = string(request, "appId")
  let app = try appById(id)
  _ = try grant(app, request: request, host: host, needed: "view")
  try checkGrants(request)
  let snapshotId = UUID().uuidString
  let root = applicationElement(app.processIdentifier)
  let window: AXUIElement
  let inspectRoot: AXUIElement
  let hasSnapshot = request["snapshotId"] != nil
  let hasElement = request["elementRef"] != nil
  guard hasSnapshot == hasElement else { throw Failure("UnsupportedAction") }
  if hasSnapshot {
    let (snapshot, element, _) = try resolveSnapshotElement(request, app: app)
    window = snapshot.window
    inspectRoot = element
  } else {
    guard
      let focused = axElement(attribute(root, kAXFocusedWindowAttribute))
        ?? (attribute(root, kAXWindowsAttribute) as? [AXUIElement])?.first
    else { return ["snapshotId": snapshotId, "appId": id, "accessible": false, "nodes": []] }
    window = focused
    inspectRoot = focused
  }
  let windowFrame = axRect(window)
  let allDisplays = displays()
  var nodes: [[String: Any]] = []
  var elements: [String: AXUIElement] = [:]
  var roles: [String: String] = [:]
  let background = isBackground(request)
  let session = string(authorization(request), "sessionGeneration")
  let foregroundOnly = background && backgroundForegroundOnly(id, session: session)
  let inspectDeadline = ProcessInfo.processInfo.systemUptime + 6
  var byteBudget = ComputerInspectByteBudget()
  func visit(_ element: AXUIElement) throws -> (children: [AXUIElement], emitted: Bool) {
    try checkGrants(request)
    let attributes = computerInspectReadAttributes(
      batch: {
        var values: CFArray?
        let status = AXUIElementCopyMultipleAttributeValues(
          element, computerInspectAttributes, [], &values)
        return (status, values as? [AnyObject])
      }, single: { attribute(element, $0) })
    let children = attributes.children
    let rect = attributes.frame
    if let rect, let windowFrame, !rect.intersects(windowFrame) { return (children, false) }
    let role = attributes.role ?? "unknown"
    let secure =
      role == "AXSecureTextField"
      || attributes.subrole == "AXSecureTextField"
    var actionNames: CFArray?
    _ = AXUIElementCopyActionNames(element, &actionNames)
    let axActions = actionNames as? [String] ?? []
    let map = [
      "AXPress": "press", "AXIncrement": "increment", "AXDecrement": "decrement",
      "AXShowMenu": "showMenu", "AXScrollToVisible": "scrollIntoView",
    ]
    var actions = axActions.compactMap { map[$0] }
    var settable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &settable)
      == .success && settable.boolValue
    {
      actions.append("focus")
    }
    if !secure
      && AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        == .success
      && settable.boolValue
    {
      actions.append("setValue")
    }
    let name = String(
      (attributes.title ?? attributes.description ?? "").prefix(200))
    let value = secure ? nil : attribute(element, kAXValueAttribute) as? String
    let focused = attributes.focused ?? false
    if computerInspectIsWrapper(
      role: role, name: name, value: value, focused: focused, actions: actions)
    {
      return (children, false)
    }
    let ref = "e\(nodes.count + 1)"
    var node: [String: Any] = [
      "elementRef": ref, "role": String(role.prefix(200)),
      "name": name,
      "focused": focused,
      "enabled": attributes.enabled ?? true,
      // In background, list only actions that execute without the foreground.
      "actions": secure || foregroundOnly
        ? [] : background ? actions.filter { ["press", "setValue"].contains($0) } : actions,
    ]
    if let value {
      node["value"] = String(value.prefix(200))
    }
    if let rect,
      let display = allDisplays.first(where: { $0.bounds.intersects(rect) })
    {
      let x = max(
        0,
        Int(floor((rect.minX - display.bounds.minX) * Double(display.width) / display.bounds.width))
      )
      let y = max(
        0,
        Int(
          floor((rect.minY - display.bounds.minY) * Double(display.height) / display.bounds.height))
      )
      if x < display.width && y < display.height {
        node["displayId"] = String(display.id)
        node["bounds"] = [
          "x": x, "y": y,
          "width": max(
            1,
            min(
              display.width - x,
              Int(ceil(rect.width * Double(display.width) / display.bounds.width)))),
          "height": max(
            1,
            min(
              display.height - y,
              Int(ceil(rect.height * Double(display.height) / display.bounds.height)))),
        ]
      }
    }
    guard try byteBudget.include(node) else { return (children, false) }
    elements[ref] = element
    roles[ref] = role
    nodes.append(node)
    return (children, true)
  }
  let walkTruncated = try computerInspectWalk(
    root: inspectRoot, maxNodes: integer(request, "maxNodes"),
    stop: {
      if requestCancelled(string(request, "requestId")) {
        throw Failure("Interrupted", "cause", "paused")
      }
      if Date().timeIntervalSince1970 * 1000 >= number(request, "deadlineAtMs") {
        throw Failure("Execution", "message", "Accessibility observation timed out.")
      }
      return byteBudget.exceeded || ProcessInfo.processInfo.systemUptime >= inspectDeadline
    }, visit: visit)
  let auth = authorization(request)
  let snapshot = Snapshot(
    id: snapshotId, pid: app.processIdentifier, launchDate: app.launchDate,
    bundleURL: app.bundleURL, window: window,
    document: attribute(window, kAXDocumentAttribute) as? String, elements: elements,
    roles: roles, owner: string(auth, "profileId") + "\0" + string(auth, "threadId"),
    session: session, grantVersion: integer(auth, "grantVersion"), delivery: delivery(request))
  snapshotLock.lock()
  var appSnapshots = snapshots[id] ?? []
  appSnapshots.append(snapshot)
  snapshots[id] = computerRetainSnapshots(appSnapshots) { $0.owner + "\0" + $0.session }
  snapshotLock.unlock()
  var result: [String: Any] = [
    "snapshotId": snapshotId, "appId": id, "accessible": true, "nodes": nodes,
  ]
  if walkTruncated || byteBudget.exceeded { result["truncated"] = true }
  if foregroundOnly {
    result["executionNote"] =
      "This app needs the foreground; call computer_request_foreground before acting."
  } else if background {
    result["executionNote"] =
      "Background mode: press and setValue run here; other actions need computer_request_foreground."
  }
  if (try JSONSerialization.data(withJSONObject: result)).count > 512 * 1024 {
    throw Failure("ResultTooLarge")
  }
  return result
}
/// Background actions only: the target window must be one on-screen CG window (not minimized,
/// not on another Space) or the action needs the foreground.
func onScreenWindow(_ window: AXUIElement, pid: pid_t) throws -> CGRect {
  guard let rect = axRect(window) else {
    throw Failure("ForegroundRequired", "reason", "window-unavailable")
  }
  let matches = windows().filter { record in
    integer(record, kCGWindowOwnerPID as String) == Int(pid)
      && windowRect(record).map {
        abs($0.minX - rect.minX) < 1 && abs($0.minY - rect.minY) < 1
          && abs($0.width - rect.width) < 1 && abs($0.height - rect.height) < 1
      } == true
  }
  guard matches.count == 1 else {
    throw Failure("ForegroundRequired", "reason", "window-unavailable")
  }
  return rect
}
func isAncestor(_ window: AXUIElement, of element: AXUIElement, request: [String: Any]) throws
  -> Bool
{
  try computerHasAncestor(ancestor: window, element: element) { node in
    if requestCancelled(string(request, "requestId")) {
      throw Failure("Interrupted", "cause", "paused")
    }
    guard Date().timeIntervalSince1970 * 1000 < number(request, "deadlineAtMs") else {
      throw Failure("Execution", "message", "Accessibility observation timed out.")
    }
    return axElement(attribute(node, kAXParentAttribute))
  }
}
/// Inspect and actions share the same snapshot identity and liveness checks.
func resolveSnapshotElement(_ request: [String: Any], app: NSRunningApplication) throws
  -> (Snapshot, AXUIElement, String)
{
  let id = string(request, "appId")
  snapshotLock.lock()
  let snapshot = snapshots[id]?.first(where: { $0.id == string(request, "snapshotId") })
  snapshotLock.unlock()
  guard let snapshot, snapshot.pid == app.processIdentifier else {
    throw Failure("StaleElement", "reason", "snapshot-expired")
  }
  guard
    let currentWindow = axElement(
      attribute(applicationElement(app.processIdentifier), kAXFocusedWindowAttribute)),
    CFEqual(currentWindow, snapshot.window)
  else { throw Failure("StaleElement", "reason", "window-changed") }
  let background = isBackground(request)
  if background {
    let auth = authorization(request)
    guard snapshot.launchDate == app.launchDate, snapshot.bundleURL == app.bundleURL,
      snapshot.owner == string(auth, "profileId") + "\0" + string(auth, "threadId"),
      snapshot.session == string(auth, "sessionGeneration"),
      snapshot.grantVersion == integer(auth, "grantVersion"), snapshot.delivery == "background",
      (attribute(currentWindow, kAXDocumentAttribute) as? String) == snapshot.document
    else { throw Failure("StaleElement", "reason", "window-changed") }
  }
  guard let element = snapshot.elements[string(request, "elementRef")],
    let role = attribute(element, kAXRoleAttribute) as? String,
    try isAncestor(snapshot.window, of: element, request: request)
  else { throw Failure("StaleElement", "reason", "element-gone") }
  var pid: pid_t = 0
  guard AXUIElementGetPid(element, &pid) == .success, pid == app.processIdentifier else {
    throw Failure("StaleElement", "reason", "element-gone")
  }
  guard snapshot.roles[string(request, "elementRef")] == role else {
    throw Failure("StaleElement", "reason", "role-changed")
  }
  if background { _ = try onScreenWindow(currentWindow, pid: app.processIdentifier) }
  return (snapshot, element, role)
}
/// Returns read-back verification facts for background deliveries; never document text.
/// A foreground dispatch whose AX result cannot confirm its effect returns `verified: false`.
@discardableResult
func elementAction(_ request: [String: Any], _ host: [String: Any]) throws -> [String: Any]? {
  let id = string(request, "appId")
  let app = try appById(id)
  let action = string(request, "action")
  let background = isBackground(request)
  try checkPermit(request)
  _ = try grant(app, request: request, host: host, needed: action == "setValue" ? "type" : "click")
  if background { try backgroundPreflight(request, app: app) }
  let (_, element, role) = try resolveSnapshotElement(request, app: app)
  if background {
    if !(attribute(element, kAXEnabledAttribute) as? Bool ?? true) {
      throw Failure("StaleElement", "reason", "element-gone")
    }
  }
  if role == "AXSecureTextField"
    || (attribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField"
    || IsSecureEventInputEnabled()
  {
    throw Failure("TargetBlocked", "kind", "secure-field")
  }
  var pid: pid_t = 0
  guard AXUIElementGetPid(element, &pid) == .success && pid == app.processIdentifier else {
    throw Failure("StaleElement", "reason", "element-gone")
  }
  try checkPermit(request)
  // A slow app may take longer than the process-wide ceiling to act; only this element.
  if background { _ = AXUIElementSetMessagingTimeout(element, 2) }
  defer { if background { _ = AXUIElementSetMessagingTimeout(element, 0.25) } }
  let result: AXError
  if action == "setValue" || action == "focus" {
    var settable = DarwinBoolean(false)
    let name = action == "focus" ? kAXFocusedAttribute : kAXValueAttribute
    guard
      AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success
        && settable.boolValue
    else { throw Failure("UnsupportedAction") }
    try checkPermit(request)
    let dispatch = background ? beginBackgroundAction(request, app: app) : nil
    markActionStarted(request)
    result = AXUIElementSetAttributeValue(
      element, name as CFString,
      action == "focus" ? kCFBooleanTrue : string(request, "value") as CFString)
    if let dispatch { try endBackgroundAction(dispatch, succeeded: result == .success) }
  } else {
    let actions = [
      "press": "AXPress", "increment": "AXIncrement", "decrement": "AXDecrement",
      "showMenu": "AXShowMenu", "scrollIntoView": "AXScrollToVisible",
    ]
    guard let native = actions[action] else { throw Failure("UnsupportedAction") }
    if background {
      var names: CFArray?
      _ = AXUIElementCopyActionNames(element, &names)
      guard (names as? [String] ?? []).contains(native) else { throw Failure("UnsupportedAction") }
    }
    let dispatch = background ? beginBackgroundAction(request, app: app) : nil
    markActionStarted(request)
    result = AXUIElementPerformAction(element, native as CFString)
    if let dispatch { try endBackgroundAction(dispatch, succeeded: result == .success) }
  }
  switch computerElementDispatchOutcome(action: action, error: result, background: background) {
  case .success: break
  case .unverified:
    // A foreground press that removed its own element (a swatch closing its popover) worked
    // as far as AX can tell; the agent observes before acting, as for a background AXPress.
    return ["verified": false]
  case .failed(let tag, let reason, let started):
    // Errors proving nothing happened stay typed instead of escalating to OutcomeUnknown.
    if !started { locked { _ = postedRequests.remove(string(request, "requestId")) } }
    if let reason { throw Failure(tag, "reason", reason) }
    throw Failure(tag)
  }
  if action == "focus" {
    let verified = computerPollUntil(
      timeout: 0.5, cancelled: { requestCancelled(string(request, "requestId")) },
      predicate: {
        if attribute(element, kAXFocusedAttribute) as? Bool == true { return true }
        // Web content may expose focus on the application's focused element only.
        guard let focused = axElement(attribute(
          applicationElement(app.processIdentifier), kAXFocusedUIElementAttribute)) else { return false }
        return CFEqual(focused, element)
      })
    return ["verified": verified]
  }
  guard background else { return nil }
  // Bounded read-back. A read-back failure after confirmed success stays success.
  if action == "setValue" {
    let value = attribute(element, kAXValueAttribute) as? String
    guard let value else { return ["verified": false] }
    return [
      "verified": value == string(request, "value"),
      "matchesRequestedValue": value == string(request, "value"),
      "valueLength": value.count,
    ]
  }
  // AXPress reports dispatch, not effect: without a read-back it is never "verified".
  return ["verified": false]
}
/// The secure-input deadline expired before a background mutation could run.
struct SecureInputWait: Error {}
func backgroundForegroundOnly(_ appId: String, session: String) -> Bool {
  computerBackgroundForegroundOnly(appId) || locked { activationProne.contains(session + "\0" + appId) }
}
/// Shared background checks: target not frontmost, app allowed in background, secure input
/// released, and every physical input up to now resolved against this target.
func backgroundPreflight(_ request: [String: Any], app: NSRunningApplication) throws {
  let generation = integer(authorization(request), "executionGeneration")
  let appId = app.bundleIdentifier ?? ""
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
    throw Failure("TargetBlocked", "kind", "user-active")
  }
  if backgroundForegroundOnly(appId, session: string(authorization(request), "sessionGeneration"))
  {
    throw Failure("ForegroundRequired", "reason", "unsupported-app")
  }
  if IsSecureEventInputEnabled() {
    // Hold, never type into or beside a secure field. Return before the host's own deadline.
    emit([
      "type": "executionState", "executionGeneration": generation, "state": "waiting-secure-input",
    ])
    let deadline = min(
      number(request, "deadlineAtMs") / 1000 - 1, Date().timeIntervalSince1970 + 25)
    while IsSecureEventInputEnabled() {
      if Date().timeIntervalSince1970 >= deadline { throw SecureInputWait() }
      Thread.sleep(forTimeInterval: 0.1)
      try checkPermit(request)
    }
    emit(["type": "executionState", "executionGeneration": generation, "state": "active"])
  }
  let target = locked { enqueuedInputSequence }
  let until = ProcessInfo.processInfo.systemUptime + 0.25
  while locked({ resolvedInputSequence }) < target {
    guard ProcessInfo.processInfo.systemUptime < until else {
      interrupt(generation, ["type": "targetInterrupted", "appId": appId, "cause": "unresolved"])
      throw Failure("Interrupted", "cause", "user-input")
    }
    Thread.sleep(forTimeInterval: 0.005)
  }
  try checkPermit(request)
}
/// Track a dispatched background action until 500 ms after it completes.
func beginBackgroundAction(
  _ request: [String: Any], app: NSRunningApplication, frontPid: Int?? = nil
) -> String {
  let id = string(request, "requestId")
  let front =
    frontPid ?? NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) }
  let auth = authorization(request)
  locked {
    trackedActions[id] = TrackedAction(
      generation: integer(auth, "executionGeneration"), appId: app.bundleIdentifier ?? "",
      targetPid: Int(app.processIdentifier), beforeFrontPid: front,
      dispatchSequence: inputSequence, windowEnd: .infinity,
      session: string(auth, "sessionGeneration"))
  }
  return id
}
func endBackgroundAction(_ id: String, succeeded: Bool) throws {
  let now = ProcessInfo.processInfo.systemUptime
  guard
    let tracked: TrackedAction = locked({
      trackedActions[id]?.windowEnd = now + 0.5
      return trackedActions[id]
    })
  else { return }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    locked { _ = trackedActions.removeValue(forKey: id) }
  }
  let front = NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) }
  if computerActivationIncident(
    beforePid: tracked.beforeFrontPid, afterPid: front, targetPid: tracked.targetPid,
    windowEndUptime: now + 0.5, now: now)
  {
    activationIncident(id)
    // A confirmed success stays a success; the pause is reported separately.
    if !succeeded { throw Failure("ForegroundRequired", "reason", "activation-side-effect") }
  }
}
/// The target came to the front because of our action: pause, quarantine the app for this
/// provider session, and restore the previous app only if the user has not touched anything.
func activationIncident(_ id: String) {
  guard let tracked: TrackedAction = locked({ trackedActions.removeValue(forKey: id) }) else {
    return
  }
  permits.suspend(tracked.generation)
  locked { _ = activationProne.insert(tracked.session + "\0" + tracked.appId) }
  let untouched = { locked { inputSequence == tracked.dispatchSequence } }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
    var restored = false
    if untouched(), let pid = tracked.beforeFrontPid,
      let previous = NSRunningApplication(processIdentifier: pid_t(pid))
    {
      restored = previous.activate(options: [])
    }
    emit([
      "type": "activationIncident", "executionGeneration": tracked.generation,
      "restored": restored,
    ])
  }
}
/// Workspace activation: a tracked action's target activating is an incident; otherwise any
/// background target becoming frontmost pauses that generation (the user is there).
func applicationActivated(_ app: NSRunningApplication) {
  let pid = Int(app.processIdentifier)
  let now = ProcessInfo.processInfo.systemUptime
  locked {
    frontmostPid = pid
    frontmostBundleId = app.bundleIdentifier
  }
  let incidents = locked {
    trackedActions.filter { $0.value.targetPid == pid && now <= $0.value.windowEnd }.map(\.key)
  }
  locked {
    for appId in Array(targetWatches.keys) {
      let owned = targetWatches[appId]?.pids ?? []
      targetWatches[appId]?.identity(pids: owned, frontmost: app.bundleIdentifier == appId, now: now)
    }
  }
  if !incidents.isEmpty {
    for incident in incidents { activationIncident(incident) }
  }
  guard let bundleId = app.bundleIdentifier else { return }
  for (generation, appId) in backgroundScopesActive() where appId == bundleId {
    interrupt(generation, ["type": "targetInterrupted", "appId": appId, "cause": "frontmost"])
  }
}
/// The OS action is done; an optional screenshot follows. Lets Electron keep a known success
/// even if a stop or activation incident arrives during capture.
func confirmAction(_ request: [String: Any]) {
  computerConfirmAction(
    requestId: string(request, "requestId"),
    executionGeneration: integer(authorization(request), "executionGeneration"), emit: emit)
}
/// Background typing: accessibility text insertion into the target's focused element only.
func backgroundType(_ request: [String: Any], _ host: [String: Any]) throws -> (
  NSRunningApplication, CGRect, [String: Any]
) {
  let id = string(request, "appId")
  let app = try appById(id)
  try checkPermit(request)
  _ = try grant(app, request: request, host: host, needed: "type")
  try backgroundPreflight(request, app: app)
  let root = applicationElement(app.processIdentifier)
  guard let element = axElement(attribute(root, kAXFocusedUIElementAttribute)),
    let window = axElement(attribute(root, kAXFocusedWindowAttribute))
  else { throw Failure("TargetBlocked", "kind", "focus-unknown") }
  let bounds = try onScreenWindow(window, pid: app.processIdentifier)
  var pid: pid_t = 0
  if let kind = computerFocusBlock(
    frontPid: Int(app.processIdentifier),
    focusedPid: AXUIElementGetPid(element, &pid) == .success ? Int(pid) : nil,
    secureInput: IsSecureEventInputEnabled(), role: attribute(element, kAXRoleAttribute) as? String,
    subrole: attribute(element, kAXSubroleAttribute) as? String)
  {
    throw Failure("TargetBlocked", "kind", kind)
  }
  var settable = DarwinBoolean(false)
  guard
    AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable)
      == .success && settable.boolValue
  else { throw Failure("ForegroundRequired", "reason", "typing-unsupported") }
  let characters = Array(string(request, "text"))
  guard characters.count <= 10_000 else { throw Failure("ResultTooLarge") }
  let before = attribute(element, kAXValueAttribute) as? String
  var readable = before != nil
  var start = 0
  while start < characters.count {
    // Once any chunk was inserted, a stop is no longer a clean interruption: the text is
    // partially typed and a retry would duplicate it.
    do { try checkPermit(request) } catch { throw start == 0 ? error : Failure("OutcomeUnknown") }
    guard let currentElement = axElement(attribute(root, kAXFocusedUIElementAttribute)),
      let currentWindow = axElement(attribute(root, kAXFocusedWindowAttribute)),
      CFEqual(currentElement, element), CFEqual(currentWindow, window),
      !IsSecureEventInputEnabled()
    else { throw start == 0 ? Failure("TargetBlocked", "kind", "focus-unknown") : Failure("OutcomeUnknown") }
    let end = min(start + 32, characters.count)
    let dispatch = beginBackgroundAction(request, app: app)
    markActionStarted(request)
    let result = AXUIElementSetAttributeValue(
      element, kAXSelectedTextAttribute as CFString, String(characters[start..<end]) as CFString)
    try endBackgroundAction(dispatch, succeeded: result == .success)
    guard result == .success else {
      // Only errors that establish the write never applied are safe to retry in the
      // foreground; cannotComplete and generic failures may already have inserted text.
      throw start == 0 && computerAXWriteRejected(result)
        ? Failure("ForegroundRequired", "reason", "typing-unsupported")
        : Failure("OutcomeUnknown")
    }
    if start == 0 {
      // Some apps accept the attribute write and ignore it: nothing was typed.
      let after = attribute(element, kAXValueAttribute) as? String
      if let before, let after, after == before {
        throw Failure("ForegroundRequired", "reason", "typing-unsupported")
      }
      readable = readable && after != nil
    }
    start = end
  }
  let final = attribute(element, kAXValueAttribute) as? String
  var verification: [String: Any] = ["verified": readable && final != nil && final != before]
  if let final { verification["valueLength"] = final.count }
  return (app, bounds, verification)
}
/// A capture whose content does not line up with the granted windows' frames.
struct CaptureLayoutMismatch: Error {}
/// Window animations or transient popovers can briefly misplace content between the window
/// snapshot and the capture, so a mismatch is retried once before it fails the request.
func screenshot(_ request: [String: Any], _ host: [String: Any]) async throws -> [String: Any] {
  for attempt in 0..<2 {
    do { return try await captureScreenshot(request, host) } catch is CaptureLayoutMismatch {
      if attempt == 1 { break }
    }
  }
  throw Failure("Execution", "message", "Capture layout did not match window positions.")
}
func captureScreenshot(_ request: [String: Any], _ host: [String: Any]) async throws -> [String: Any]
{
  try checkGrants(request)
  guard CGPreflightScreenCaptureAccess() else {
    throw Failure("Unavailable", "reason", "missing-permissions",
      captureFailure: computerCaptureFailureDiagnostic(stage: .permissionPreflight))
  }
  // App-scoped (background) capture: only the named app, including covered windows. Never
  // activates, unminimizes or switches Spaces. The display follows the target's focused window.
  let scopedAppId = (request["appId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
  var scopedWindow: CGRect?
  if let scopedAppId {
    let app = try appById(scopedAppId)
    _ = try grant(app, request: request, host: host, needed: "view")
    let root = applicationElement(app.processIdentifier)
    guard
      let window = axElement(attribute(root, kAXFocusedWindowAttribute))
        ?? (attribute(root, kAXWindowsAttribute) as? [AXUIElement])?.first,
      let rect = axRect(window)
    else { throw Failure("ForegroundRequired", "reason", "window-unavailable") }
    scopedWindow = rect
  }
  let target: Display
  if let scopedWindow, string(request, "displayId").isEmpty {
    let center = CGPoint(x: scopedWindow.midX, y: scopedWindow.midY)
    guard
      let match = displays().first(where: { $0.bounds.contains(center) })
        ?? displays().first(where: { $0.bounds.intersects(scopedWindow) })
    else { throw Failure("ForegroundRequired", "reason", "window-unavailable") }
    target = match
  } else {
    target = try display(string(request, "displayId"))
    if let scopedWindow, !target.bounds.intersects(scopedWindow) {
      throw Failure("GeometryChanged")
    }
  }
  let grants = authorization(request)["grants"] as? [[String: Any]] ?? []
  let f5Pids = host["f5Pids"] as? [Int] ?? []
  let content: SCShareableContent
  do {
    content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  } catch {
    throw Failure("Unavailable", "reason", "missing-permissions",
      captureFailure: computerCaptureFailureDiagnostic(stage: .shareableContent, error: error))
  }
  let apps = content.applications.filter { app in
    !f5Pids.contains(Int(app.processID)) && tier(app.bundleIdentifier) != "blocked"
      && grants.contains(where: { string($0, "appId") == app.bundleIdentifier })
      && (scopedAppId == nil || app.bundleIdentifier == scopedAppId)
  }
  guard let screen = content.displays.first(where: { $0.displayID == target.id }) else {
    throw Failure("GeometryChanged")
  }
  // An include-app filter with no windows on this display can fail in SCK.
  // Establish emptiness from fresh on-screen metadata, never from a capture error.
  let captureApps = apps.filter { app in
    content.windows.contains { window in
      window.owningApplication?.processID == app.processID
        && computerCaptureWindowIntersectsDisplay(window: window.frame, display: target.bounds)
    }
  }
  let zoom = string(request, "op") == "zoom"
  let captureScale = min(1.0, 2560.0 / Double(max(target.pixelWidth, target.pixelHeight)))
  let captureWidth =
    zoom ? max(1, Int(floor(Double(target.pixelWidth) * captureScale))) : target.width
  let captureHeight =
    zoom ? max(1, Int(floor(Double(target.pixelHeight) * captureScale))) : target.height
  // The menu bar belongs to the frontmost app, never to a background target.
  let includeMenuBar =
    scopedAppId == nil
    && (NSWorkspace.shared.frontmostApplication.map { front in
      captureApps.contains(where: { $0.processID == front.processIdentifier })
    } ?? false)
  let canvas: CGContext
  do {
    canvas = try await authorizedComputerCaptureCanvas(
      width: captureWidth, height: captureHeight, applicationCount: captureApps.count
    ) {
      let filter = SCContentFilter(display: screen, including: captureApps, exceptingWindows: [])
      if #available(macOS 14.2, *) { filter.includeMenuBar = includeMenuBar }
      return try await withComputerCaptureConfiguration(
        width: captureWidth, height: captureHeight, displaySize: target.bounds.size
      ) {
        configuration in
        do {
          return try await SCScreenshotManager.captureImage(
            contentFilter: filter, configuration: configuration)
        } catch {
          throw Failure("Unavailable", "reason", "missing-permissions",
            captureFailure: computerCaptureFailureDiagnostic(stage: .imageCapture, error: error))
        }
      }
    }
  } catch let error as Failure { throw error }
  catch { throw Failure("Execution", "message", "Unable to encode capture.") }
  try checkGrants(request)
  guard try display(String(target.id)).generation == target.generation else {
    throw Failure("GeometryChanged")
  }
  // Mask secure fields; an incomplete tree cannot establish that remaining pixels are safe.
  var maskIncomplete = false
  func canvasRect(_ rect: CGRect) -> CGRect {
    computerCanvasRect(
      rect, display: target.bounds, canvasWidth: captureWidth, canvasHeight: captureHeight)
  }
  func fillMask(_ rect: CGRect) {
    let r = canvasRect(rect)
    // Rounded outward with 2 px of padding toward the top and right, as before.
    let padded = CGRect(
      x: floor(r.minX), y: ceil(r.maxY) - ceil(r.height) - 2, width: ceil(r.width) + 2,
      height: ceil(r.height) + 2)
    canvas.setFillColor(CGColor(gray: 0.45, alpha: 1))
    canvas.fill(computerCanvasDrawRect(padded, canvasHeight: captureHeight))
  }
  let capturedWindows = content.windows.filter { window in
    captureApps.contains { $0.processID == window.owningApplication?.processID }
      && computerCaptureWindowIntersectsDisplay(window: window.frame, display: target.bounds)
  }
  let maskStarted = ProcessInfo.processInfo.systemUptime
  let maskDeadline = maskStarted + 2
  let passwordMasking = ComputerPasswordMasking.requested(request["passwordMasking"] as? String)
  let searchEnabled = passwordMasking.usesWebAreaSearch
  var auditDiagnostics: [[String: Any]] = []
  var appWindows: [pid_t: [AXUIElement]] = [:]
  var maskOutcomes: [ComputerCaptureMaskOutcome] = []
  let masks = computerSecureCaptureMasks(windows: capturedWindows.map(\.frame)) { index in
    let captured = capturedWindows[index]
    let diagnostics = ComputerSecureAuditDiagnostics()
    let started = ProcessInfo.processInfo.systemUptime
    var complete = false
    defer {
      auditDiagnostics.append([
        "windowIndex": index, "complete": complete,
        "elapsedMs": max(0, Int((ProcessInfo.processInfo.systemUptime - started) * 1000)),
        "visitedNodes": diagnostics.visitedNodes,
        "nodeReadElapsedMs": diagnostics.nodeReadElapsedMs, "maxChildren": diagnostics.maxChildren,
        "textFieldQueries": diagnostics.textFieldQueries, "frameQueries": diagnostics.frameQueries,
        "searchResults": diagnostics.searchResults, "searchFallbacks": diagnostics.searchFallbacks,
        "searchElapsedMs": diagnostics.searchElapsedMs,
        "invalidSearchResults": diagnostics.invalidSearchResults,
        "stopReasons": diagnostics.stopReasons.map(\.rawValue).sorted(),
        "axFailures": diagnostics.axFailures.map {
          ["operation": $0.operation.rawValue, "error": $0.error, "count": $0.count]
            as [String: Any]
        },
      ])
    }
    guard ProcessInfo.processInfo.systemUptime < maskDeadline,
      let pid = captured.owningApplication?.processID
    else {
      diagnostics.stop(.deadline)
      maskOutcomes.append(ComputerCaptureMaskOutcome(.window, reasons: [.auditIncomplete]))
      return nil
    }
    if appWindows[pid] == nil {
      let root = applicationElement(pid)
      appWindows[pid] = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
    }
    // Resolve this exact captured window. Ambiguous or missing AX ownership is hidden.
    guard
      let matched = computerMatchAXWindow(
        windows: appWindows[pid] ?? [], windowID: captured.windowID, frame: captured.frame,
        id: windowIdentifier, rect: axRect,
        minimized: { attribute($0, kAXMinimizedAttribute) as? Bool ?? false })
    else {
      diagnostics.stop(.windowMatch)
      maskOutcomes.append(ComputerCaptureMaskOutcome(.window, reasons: [.windowMatch]))
      return nil
    }
    // The node budget bounds the walk; the depth limit only guards pathological trees, since
    // a cutoff masks the whole enclosing web or scroll area.
    let windowDeadline = computerSecureAuditDeadline(
      now: ProcessInfo.processInfo.systemUptime, end: maskDeadline,
      windowsLeft: capturedWindows.count - index)
    let expired = { ProcessInfo.processInfo.systemUptime >= windowDeadline }
    let audit = computerSecureAudit(
      root: matched, read: { secureAuditNode($0, diagnostics: diagnostics) }, maxDepth: 256,
      maxNodes: 20000,
      expired: expired,
      search: searchEnabled
        ? { secureAuditSearch($0, expired: expired, diagnostics: diagnostics) } : nil,
      diagnostics: diagnostics)
    complete = audit?.complete ?? false
    if let audit {
      maskOutcomes.append(
        ComputerCaptureMaskOutcome(
          audit.complete ? (audit.rects.isEmpty ? .none : .fields) : .webArea,
          reasons: audit.complete ? [] : [.partialAudit]))
    } else {
      maskOutcomes.append(ComputerCaptureMaskOutcome(.window, reasons: [.auditIncomplete]))
    }
    return audit
  }
  let auditElapsedMs = max(0, Int((ProcessInfo.processInfo.systemUptime - maskStarted) * 1000))
  maskIncomplete = masks.incomplete
  for rect in masks.rects { fillMask(rect) }
  // Capture and AX traversal are separate OS calls. If a granted window moved,
  // appeared or disappeared, old mask coordinates cannot establish safe pixels.
  let after: SCShareableContent
  do {
    after = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  } catch {
    throw Failure("Unavailable", "reason", "missing-permissions",
      captureFailure: computerCaptureFailureDiagnostic(stage: .shareableContent, error: error))
  }
  let afterWindows = after.windows.filter { window in
    captureApps.contains { $0.processID == window.owningApplication?.processID }
      && computerCaptureWindowIntersectsDisplay(window: window.frame, display: target.bounds)
  }
  if capturedWindows.count != afterWindows.count || capturedWindows.contains(where: { before in
    !afterWindows.contains { $0.windowID == before.windowID && $0.frame == before.frame
      && $0.owningApplication?.processID == before.owningApplication?.processID }
  }) {
    maskIncomplete = true
    maskOutcomes.append(ComputerCaptureMaskOutcome(.window, reasons: [.windowsChanged]))
    fillMask(target.bounds)
  }
  if !captureApps.isEmpty {
    // Fail closed: pixels outside the granted windows' real frames mean the capture is
    // misplaced, and coordinates read from it would land on other content.
    // The filter includes applications, not the enumerated window list, so allow every
    // on-screen window those apps own, desktop elements included (Finder's desktop icons).
    let capturedPids = Set(captureApps.map { Int($0.processID) })
    let records =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    let ownedFrames = records.filter {
      capturedPids.contains(integer($0, kCGWindowOwnerPID as String))
    }.compactMap(windowRect).filter { $0.intersects(target.bounds) }
    // Before 14.2 the menu bar cannot be excluded explicitly, so its strip is always allowed.
    var menuBarAllowed = includeMenuBar
    if #unavailable(macOS 14.2) { menuBarAllowed = true }
    let menuBar =
      menuBarAllowed
      ? [
        computerMenuBarBand(
          display: target.bounds,
          menuWindows: records.filter {
            integer($0, kCGWindowLayer as String) == Int(CGWindowLevelForKey(.mainMenuWindow))
          }.compactMap(windowRect))
      ] : []
    if computerCaptureContentOutside(
      canvas, allowed: (capturedWindows.map(\.frame) + ownedFrames + menuBar).map(canvasRect))
    {
      throw CaptureLayoutMismatch()
    }
  }
  try checkGrants(request)
  guard var encoded = canvas.makeImage() else {
    throw Failure("Execution", "message", "Unable to encode capture.")
  }
  if zoom {
    let rect = request["rect"] as? [String: Any] ?? [:]
    guard
      let crop = zoomPixelBounds(
        x: integer(rect, "x"), y: integer(rect, "y"), width: integer(rect, "width"),
        height: integer(rect, "height"), modelWidth: target.width, modelHeight: target.height,
        captureWidth: captureWidth, captureHeight: captureHeight),
      let cropped = encoded.cropping(
        to: CGRect(x: crop.x, y: crop.y, width: crop.width, height: crop.height))
    else { throw Failure("GeometryChanged") }
    encoded = cropped
    let (width, height) = modelSize(width: encoded.width, height: encoded.height)
    if width != encoded.width || height != encoded.height {
      guard
        let scaled = CGContext(
          data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { throw Failure("Execution") }
      scaled.interpolationQuality = .high
      scaled.draw(encoded, in: CGRect(x: 0, y: 0, width: width, height: height))
      guard let resized = scaled.makeImage() else { throw Failure("Execution") }
      encoded = resized
    }
  }
  let bitmap = NSBitmapImageRep(cgImage: encoded)
  guard
    let bytes = bitmap.representation(
      using: zoom ? .png : .jpeg, properties: zoom ? [:] : [.compressionFactor: 0.75])
  else { throw Failure("Execution", "message", "Unable to encode capture.") }
  let data = bytes.base64EncodedString()
  guard data.utf8.count <= 8 * 1024 * 1024 else { throw Failure("ResultTooLarge") }
  let hidden =
    maskIncomplete
    || content.windows.contains { window in
      guard window.frame.intersects(target.bounds) else { return false }
      return window.owningApplication.map { app in
        !apps.contains(where: { $0.processID == app.processID })
      }
        ?? true
    }
  var result: [String: Any] = [
    "displayId": String(target.id), "geometryGeneration": target.generation,
    "modelSize": ["width": encoded.width, "height": encoded.height],
    "mimeType": zoom ? "image/png" : "image/jpeg", "data": data, "hiddenContent": hidden,
  ]
  let maskSummary = computerCaptureMaskSummary(maskOutcomes)
  result["passwordMasking"] = passwordMasking.rawValue
  result["masked"] = maskSummary.masked
  result["maskReasons"] = maskSummary.maskReasons
  result["secureAudit"] = [
    "searchEnabled": searchEnabled,
    "elapsedMs": auditElapsedMs,
    "windows": auditDiagnostics,
  ]
  if scopedAppId != nil {
    // App-scoped evidence: the captured display, and no cursor (the user's pointer is theirs).
    if zoom { result["rect"] = request["rect"] }
    result["captureScope"] = "app"
    return result
  }
  let allDisplays = displays()
  let pointer = CGEvent(source: nil)?.location
  guard
    let resultDisplay = allDisplays.first(where: { String($0.id) == string(request, "displayId") })
      ?? allDisplays.first(where: { pointer.map($0.bounds.contains) ?? false }) ?? allDisplays.first
  else { throw Failure("GeometryChanged") }
  result["displayId"] = String(resultDisplay.id)
  result["geometryGeneration"] = resultDisplay.generation
  if let pointer, let cursorDisplay = allDisplays.first(where: { $0.bounds.contains(pointer) }) {
    result["cursor"] = [
      "displayId": String(cursorDisplay.id),
      "x": (pointer.x - cursorDisplay.bounds.minX) * Double(cursorDisplay.width)
        / cursorDisplay.bounds.width,
      "y": (pointer.y - cursorDisplay.bounds.minY) * Double(cursorDisplay.height)
        / cursorDisplay.bounds.height,
    ]
  }
  if zoom { result["rect"] = request["rect"] }
  return result
}
func keyChord(_ raw: String) throws -> (CGKeyCode, CGEventFlags) {
  guard let chord = computerKeyChord(raw) else { throw Failure("UnsupportedAction") }
  let flags = chord.flags
  if blockedComputerChord(
    key: chord.key, command: flags.contains(.maskCommand), control: flags.contains(.maskControl),
    alt: flags.contains(.maskAlternate), shift: flags.contains(.maskShift))
  {
    throw Failure("TargetBlocked", "kind", "system-ui")
  }
  return (chord.code, flags)
}
/// The request/generation that owns any input this request presses.
func inputOwner(_ request: [String: Any]) -> HeldComputerInputOwner {
  HeldComputerInputOwner(
    requestId: string(request, "requestId"),
    generation: integer(authorization(request), "executionGeneration"))
}
func openInstalledApp(
  _ request: [String: Any], _ host: [String: Any], activates: Bool
) async throws -> NSRunningApplication {
  let id = string(request, "appId")
  _ = resolveApps([id])
  let resolvedURL = catalogLock.withLock { installed[id] }
  guard let url = resolvedURL else {
    throw Failure("Execution", "message", "App was not resolved from installed applications.")
  }
  guard !url.standardizedFileURL.path.hasPrefix(string(host, "f5BundlePath")),
    !NSRunningApplication.runningApplications(withBundleIdentifier: id).contains(where: {
      (host["f5Pids"] as? [Int] ?? []).contains(Int($0.processIdentifier))
    })
  else { throw Failure("TargetBlocked", "kind", "f5") }
  try checkPermit(request)
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = activates
  markActionStarted(request)
  let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
  // Background: the launched process must be the granted app, not whatever the URL resolved to.
  guard activates || app.bundleIdentifier == id else {
    throw Failure("Execution", "message", "Opened app identity did not match.")
  }
  _ = try grant(app, request: request, host: host, needed: "click")
  return app
}
/// Background accessibility and certified process-directed events; no pointer or focus change.
func backgroundMutate(_ request: [String: Any], _ host: [String: Any]) async throws -> [String:
  Any]
{
  let op = string(request, "op")
  let appId = string(request, "appId")
  var verification: [String: Any]?
  do {
    switch op {
    case "elementAction": verification = try elementAction(request, host)
    case "type": verification = try backgroundType(request, host).2
    case "key", "scroll": verification = try backgroundEvents(request, host)
    case "openApp":
      let id = string(request, "appId")
      if tier(id) == "blocked" { throw Failure("TargetBlocked", "kind", "protection-unknown") }
      let before = NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) }
      let app = try await openInstalledApp(request, host, activates: false)
      // Launching without activation is a request, not a guarantee: catch activation.
      let dispatch = beginBackgroundAction(request, app: app, frontPid: before)
      try endBackgroundAction(dispatch, succeeded: true)
    default: throw Failure("ForegroundRequired", "reason", "unsupported-in-background")
    }
  } catch is SecureInputWait {
    return [
      "frontmostApp": NSNull(), "cursor": NSNull(), "actionCompleted": false,
      "waiting": "secure-input", "delivery": "background", "target": ["appId": appId],
      "displayId": displays().first.map { String($0.id) } ?? "unknown",
      "geometryGeneration": displays().first?.generation ?? "unknown",
    ]
  }
  confirmAction(request)
  refreshWindowCache()
  var result: [String: Any] = [
    "frontmostApp": NSNull(), "cursor": NSNull(), "actionCompleted": true,
    "delivery": "background", "target": ["appId": appId],
  ]
  if let verification { result["verification"] = verification }
  if let current = displays().first {
    result["displayId"] = String(current.id)
    result["geometryGeneration"] = current.generation
  } else {
    result["displayId"] = "unknown"
    result["geometryGeneration"] = "unknown"
  }
  if request["screenshot"] as? Bool == true {
    var capture = request
    capture["op"] = "screenshot"
    capture.removeValue(forKey: "displayId")
    do {
      let image = try await screenshot(capture, host)
      result["screenshot"] = image
      result["displayId"] = image["displayId"]
      result["geometryGeneration"] = image["geometryGeneration"]
    } catch let failure as Failure {
      result["screenshotError"] = failure.payload["_tag"] ?? "Execution"
    } catch { result["screenshotError"] = "Execution" }
  }
  return result
}
/// Performs one input action. Once input is posted, a thrown failure means the outcome is
/// unknown, so outcomes the action caused itself (focus moved by a shortcut, an element
/// removed by its own press) are returned as unverified success instead of thrown.
func mutate(_ request: [String: Any], _ host: [String: Any], deferredSettle: inout Bool) async throws -> [String: Any] {
  let op = string(request, "op")
  try checkPermit(request)
  let owner = inputOwner(request)
  defer { releaseHeldInput(where: { $0 == owner }) }
  if isBackground(request) { return try await backgroundMutate(request, host) }
  var verification: [String: Any]?
  var keyFocusUnchanged: (() -> Bool)?
  if ["click", "move", "drag", "scroll"].contains(op) {
    let target = try display(string(request, "displayId"))
    guard target.generation == string(request, "geometryGeneration") else {
      throw Failure("GeometryChanged")
    }
    if op == "drag" {
      let from = request["from"] as? [String: Any] ?? [:]
      let to = request["to"] as? [String: Any] ?? [:]
      let a = try target.point(integer(from, "x"), integer(from, "y"))
      let b = try target.point(integer(to, "x"), integer(to, "y"))
      try postMouse(.leftMouseDown, a, .left, request: request, host: host)
      for step in 1...12 {
        let p = CGPoint(
          x: a.x + (b.x - a.x) * Double(step) / 12, y: a.y + (b.y - a.y) * Double(step) / 12)
        try postMouse(.leftMouseDragged, p, .left, request: request, host: host)
        try await Task.sleep(nanoseconds: 16_000_000)
      }
      try postMouse(.leftMouseUp, b, .left, request: request, host: host)
    } else {
      let point = try target.point(integer(request, "x"), integer(request, "y"))
      if op == "move" {
        try postMouse(.mouseMoved, point, .left, request: request, host: host)
      } else if op == "click" {
        let name = string(request, "button")
        let button: CGMouseButton = name == "right" ? .right : name == "middle" ? .center : .left
        let down: CGEventType =
          button == .right ? .rightMouseDown : button == .center ? .otherMouseDown : .leftMouseDown
        let up: CGEventType =
          button == .right ? .rightMouseUp : button == .center ? .otherMouseUp : .leftMouseUp
        var flags: CGEventFlags = []
        for modifier in request["modifiers"] as? [String] ?? [] {
          if modifier == "Meta" { flags.insert(.maskCommand) }
          if modifier == "Control" { flags.insert(.maskControl) }
          if modifier == "Alt" { flags.insert(.maskAlternate) }
          if modifier == "Shift" { flags.insert(.maskShift) }
        }
        for count in 1...max(1, min(3, integer(request, "clickCount"))) {
          try postMouse(
            down, point, button, request: request, host: host, clickCount: count, flags: flags)
          try postMouse(
            up, point, button, request: request, host: host, clickCount: count, flags: flags)
        }
      } else {
        try postMouse(.mouseMoved, point, .left, request: request, host: host)
        try authorizePoint(point, request: request, host: host)
        try inputLock.withLock {
          guard
            let event = CGEvent(
              scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
              wheel1: -Int32(number(request, "deltaY")), wheel2: -Int32(number(request, "deltaX")),
              wheel3: 0)
          else { throw Failure("UnsupportedAction") }
          event.location = point
          event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
          try checkPermit(request)
          postActionEvent(event, request)
        }
      }
    }
  } else if op == "type" || op == "key" {
    let initial = try focused(request, host, needed: "type")
    func validateFocus() throws {
      try checkPermit(request)
      let current = try focused(request, host, needed: "type")
      guard
        computerFocusUnchanged(
          initialPid: Int(initial.0.processIdentifier),
          currentPid: Int(current.0.processIdentifier), sameWindow: CFEqual(current.2, initial.2),
          sameElement: CFEqual(current.1, initial.1), typing: op == "type")
      else { throw Failure("TargetBlocked", "kind", "focus-unknown") }
    }
    if op == "type" {
      let characters = Array(string(request, "text"))
      guard characters.count <= 10_000 else { throw Failure("ResultTooLarge") }
      var start = 0
      while start < characters.count {
        try validateFocus()
        let end = min(start + 32, characters.count)
        let units = Array(String(characters[start..<end]).utf16)
        for down in [true, false] {
          try validateFocus()
          try inputLock.withLock {
            guard let event = computerKeyboardEvent(keyCode: 0, keyDown: down, unicode: units) else {
              throw Failure("UnsupportedAction")
            }
            try checkPermit(request)
            if down { pressedKeys.insert(0, owner: owner) }
            postActionEvent(event, request)
            if !down { pressedKeys.remove(0) }
          }
        }
        start = end
        try await Task.sleep(nanoseconds: 10_000_000)
      }
    } else {
      let chords = request["chords"] as? [String] ?? []
      guard !chords.isEmpty && chords.count <= 16 else { throw Failure("UnsupportedAction") }
      let repeats = max(1, min(20, integer(request, "repeat")))
      var delivered = 0
      func focusUnchanged() -> Bool {
        guard let current = try? focused(request, host, needed: "type") else { return false }
        return computerFocusUnchanged(
          initialPid: Int(initial.0.processIdentifier),
          currentPid: Int(current.0.processIdentifier), sameWindow: CFEqual(current.2, initial.2),
          sameElement: CFEqual(current.1, initial.1), typing: false)
      }
      chordLoop: for _ in 0..<repeats {
        for raw in chords {
          let (code, flags) = try keyChord(raw)
          // Focus is checked before each keydown only. A shortcut such as Cmd+N moves focus
          // as its own effect, so checking between keydown and keyup would misreport it.
          try checkPermit(request)
          // Before any chord, nothing happened yet: the original failure stays exact.
          if delivered == 0 { _ = try focused(request, host, needed: "type") }
          switch computerChordStep(chordsDelivered: delivered, focusUnchanged: focusUnchanged()) {
          case .send: break
          case .blocked: throw Failure("TargetBlocked", "kind", "focus-unknown")
          case .stop:
            // The remaining chords were never sent; say how many were.
            verification = [
              "verified": false, "chordsDelivered": delivered,
              "chordsRequested": chords.count * repeats,
            ]
            break chordLoop
          }
          guard let down = computerKeyboardEvent(keyCode: code, keyDown: true, modifiers: flags),
            let up = computerKeyboardEvent(keyCode: code, keyDown: false, modifiers: flags)
          else { throw Failure("UnsupportedAction") }
          try inputLock.withLock {
            try checkPermit(request)
            pressedKeys.insert(code, owner: owner)
            postActionEvent(down, request)
          }
          // A posted keydown always gets its keyup, even after a stop or focus change.
          inputLock.withLock {
            postActionEvent(up, request)
            pressedKeys.remove(code)
          }
          delivered += 1
        }
      }
      // A last chord that moves focus (a single Cmd+N) must still tell the agent to observe;
      // the app may open its window after the keyup, so the check runs during settling.
      if verification == nil { keyFocusUnchanged = focusUnchanged }
    }
  } else if op == "elementAction" {
    verification = try elementAction(request, host)
  } else if op == "activateApp" || op == "openApp" {
    let id = string(request, "appId")
    if tier(id) == "blocked" { throw Failure("TargetBlocked", "kind", "protection-unknown") }
    guard
      (authorization(request)["grants"] as? [[String: Any]] ?? []).contains(where: {
        string($0, "appId") == id && ["click", "full"].contains(string($0, "tier"))
      })
    else { throw Failure("NotGranted", "needed", "click") }
    if op == "activateApp" {
      let app = try appById(id)
      _ = try grant(app, request: request, host: host, needed: "click")
      try checkPermit(request)
      markActionStarted(request)
      guard app.activate(options: []) else {
        throw Failure("Execution", "message", "App activation failed.")
      }
    } else {
      _ = try await openInstalledApp(request, host, activates: true)
    }
  } else {
    throw Failure("UnsupportedAction")
  }
  confirmAction(request)
  // See execute's pending deadline: defer only when metadata cannot select a later target.
  let settle = computerPostActionSettleMs(
    op: op, screenshot: request["screenshot"] as? Bool == true,
    appTargeted: !string(request, "appId").isEmpty, displayCount: displays().count)
  deferredSettle = settle == 0
  if let keyFocusUnchanged {
    // Spend the settle window watching for the shortcut's own focus change. Waiting it out
    // inline replaces the deferred settle; an early exit keeps the gap for the next action.
    let started = ProcessInfo.processInfo.systemUptime
    let moved = computerPollUntil(
      timeout: 0.3, cancelled: { requestCancelled(string(request, "requestId")) },
      predicate: { !keyFocusUnchanged() })
    if moved { verification = ["verified": false] }
    let remaining = Double(settle) / 1000 - (ProcessInfo.processInfo.systemUptime - started)
    if remaining > 0 { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) }
    deferredSettle = moved && settle == 0
  } else if settle > 0 {
    try await Task.sleep(nanoseconds: UInt64(settle) * 1_000_000)
  }
  var result: [String: Any] = [
    "frontmostApp": NSWorkspace.shared.frontmostApplication.flatMap(appRecord) ?? NSNull(),
    "cursor": NSNull(), "actionCompleted": true,
  ]
  if let verification { result["verification"] = verification }
  let allDisplays = displays()
  let windowFrame = NSWorkspace.shared.frontmostApplication.flatMap { app in
    axElement(attribute(applicationElement(app.processIdentifier), kAXFocusedWindowAttribute))
      .flatMap(axRect)
  }
  let actionDisplayId = computerActionDisplayID(
    requestedID: request["displayId"] as? String, windowFrame: windowFrame,
    displays: allDisplays.map { (id: String($0.id), bounds: $0.bounds) })
  if let current = allDisplays.first(where: { String($0.id) == actionDisplayId }) {
    result["displayId"] = String(current.id)
    result["geometryGeneration"] = current.generation
  } else {
    result["displayId"] = "unknown"
    result["geometryGeneration"] = "unknown"
    result["screenshotError"] = "GeometryChanged"
  }
  if request["screenshot"] as? Bool == true {
    var capture = request
    capture["op"] = "screenshot"
    if string(capture, "displayId").isEmpty, let actionDisplayId {
      capture["displayId"] = actionDisplayId
    }
    do {
      try checkPermit(request)
      result["screenshot"] = try await screenshot(capture, host)
    } catch let failure as Failure {
      result["screenshotError"] = failure.payload["_tag"] ?? "Execution"
    } catch { result["screenshotError"] = "Execution" }
  }
  return result
}
func execute(_ message: [String: Any]) {
  let request = message["request"] as? [String: Any] ?? [:]
  let host = message["hostAuthorization"] as? [String: Any] ?? [:]
  let id = string(request, "requestId")
  let op = string(request, "op")
  let generation = integer(authorization(request), "executionGeneration")
  let tracked = ![
    "status", "listApps", "resolveApps", "inspect", "screenshot", "zoom",
  ].contains(op)
  // The in-flight table maps cancel/drain to the request's generation.
  if tracked {
    locked {
      inFlight[id] = generation
      inFlightByGeneration[generation, default: 0] += 1
    }
  }
  let completed = DispatchSemaphore(value: 0)
  Task {
    defer {
      locked { _ = postedRequests.remove(id) }
      if tracked {
        locked {
          inFlight.removeValue(forKey: id)
          let remaining = (inFlightByGeneration[generation] ?? 1) - 1
          inFlightByGeneration[generation] = remaining > 0 ? remaining : nil
        }
      }
      completed.signal()
    }
    do {
      // Deferred foreground settle applies across queues, before any authorization checks.
      // See mutate's metadata-dependent inline settle rule.
      if !["status", "listApps", "resolveApps"].contains(op) {
        while true {
          if requestCancelled(id) {
            throw Failure("Interrupted", "cause", "paused")
          }
          let remaining = locked { pendingSettleDeadline } - ProcessInfo.processInfo.systemUptime
          if remaining <= 0 { break }
          try await Task.sleep(nanoseconds: UInt64(min(0.025, remaining) * 1_000_000_000))
        }
      }
      let result: Any
      var deferredSettle = false
      switch op {
      case "status": result = permissions()
      case "listApps": result = protectAppRecords(listApps(), host)
      case "resolveApps":
        result = protectAppRecords(resolveApps(request["queries"] as? [String] ?? []), host)
      case "inspect": result = try inspect(request, host)
      case "screenshot", "zoom": result = try await screenshot(request, host)
      default: result = try await mutate(request, host, deferredSettle: &deferredSettle)
      }
      if deferredSettle {
        locked { pendingSettleDeadline = ProcessInfo.processInfo.systemUptime + 0.3 }
      }
      emit(["type": "response", "requestId": id, "result": result])
    } catch let failure as Failure {
      let started = locked { postedRequests.contains(id) }
      if tracked && !isBackground(request) && started {
        locked { pendingSettleDeadline = ProcessInfo.processInfo.systemUptime + 0.3 }
      }
      let error = computerActionFailure(
        failure.payload, tracked: tracked, background: isBackground(request), posted: started)
      emit(["type": "response", "requestId": id, "error": error])
    } catch {
      let started = tracked && locked { postedRequests.contains(id) }
      if started && !isBackground(request) {
        locked { pendingSettleDeadline = ProcessInfo.processInfo.systemUptime + 0.3 }
      }
      emit([
        "type": "response", "requestId": id,
        "error": started ? ["_tag": "OutcomeUnknown"] : ["_tag": "Execution", "message": "Native action failed."],
      ])
    }
  }
  completed.wait()
}
let hello: [String: Any] = [
  "type": "hello", "protocolVersion": 1, "helperVersion": "2.1.0",
  "capabilities": helperCapabilities,
]
guard let lockDirectory = computerDeviceLockDirectory() else {
  emit(hello)
  emit([
    "type": "status",
    "status": [
      "available": false, "reason": "helper-missing", "detail": "OS account unavailable.",
    ],
  ])
  outputQueue.sync {}
  exit(1)
}
try FileManager.default.createDirectory(atPath: lockDirectory, withIntermediateDirectories: true)
let deviceLock = ComputerDeviceLock(path: lockDirectory + "/computer-control.lock")
guard deviceLock != nil else {
  emit(hello)
  emit(["type": "status", "status": ["available": false, "reason": "other-instance"]])
  outputQueue.sync {}
  exit(0)
}
emit(hello)
// AppKit's cross-process mouse hit test needs a WindowServer connection. Initialize
// the application without a Dock icon, activation, or windows of its own.
NSApplication.shared.setActivationPolicy(.prohibited)
// Child AX objects otherwise retain the default timeout; set the process-wide ceiling.
_ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
installMonitor()
let workspaceCenter = NSWorkspace.shared.notificationCenter
let workspaceObservers = [
  workspaceCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
  ) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
      applicationActivated(app)
    }
    if !backgroundScopesActive().isEmpty { conflictQueue.async { refreshWindowCache() } }
  },
  workspaceCenter.addObserver(
    forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
  ) { _ in if !backgroundScopesActive().isEmpty { conflictQueue.async { refreshWindowCache() } } },
  workspaceCenter.addObserver(
    forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
  ) { _ in if !backgroundScopesActive().isEmpty { conflictQueue.async { refreshWindowCache() } } },
]
let heartbeat = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
heartbeat.schedule(deadline: .now(), repeating: .milliseconds(250))
heartbeat.setEventHandler {
  if eventTap == nil && AXIsProcessTrusted() { installMonitor() }
  let healthy = eventTap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false
  if !healthy && monitorHealthy { suspendAllReporting() }
  monitorHealthy = healthy
  if !healthy { suspend() }
  for generation in permits.takeExpiredGenerations() {
    releaseQueue.async { releaseHeldInput(where: { $0.generation == generation }) }
    emit(["type": "permitExpired", "executionGeneration": generation])
  }
  let active = permits.activeGenerations()
  // Inputs held by a suspended or retired generation are released.
  releaseQueue.async { releaseHeldInput(where: { active[$0.generation] == nil }) }
  // The window cache stays fresh while any background target exists.
  if active.values.contains(where: \.isBackground) || hasTargetWatches() { conflictQueue.async { refreshWindowCache() } }
  let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
  let (inputAge, sequence) = locked {
    (
      lastInputUptime > 0 ? (ProcessInfo.processInfo.systemUptime - lastInputUptime) * 1000 : -1,
      inputSequence
    )
  }
  var beat: [String: Any] = [
    "type": "heartbeat", "monitorHealthy": healthy, "suspended": active.isEmpty,
    "inputSequence": sequence, "activeGenerations": Array(active.keys).sorted(),
  ]
  if inputAge >= 0 { beat["lastUserInputAgeMs"] = Int(inputAge) }
  if let front { beat["frontmostAppId"] = front }
  beat["inputHeld"] = physicalInputHeld()
  beat["targets"] = locked {
    targetWatches.map { appId, watch in
      ["appId": appId, "activityEpoch": watch.activityEpoch,
        "lastActivityAgeMs": watch.activityAgeMs(now: ProcessInfo.processInfo.systemUptime),
        "frontmost": watch.frontmost] as [String: Any]
    }
  }
  emit(beat)
  emitStatus(permissions())
}
heartbeat.resume()
DispatchQueue.global(qos: .userInteractive).async {
  var buffer = Data()
  while let chunk = try? readComputerInputChunk(FileHandle.standardInput.fileDescriptor) {
    buffer.append(chunk)
    while let end = buffer.firstIndex(of: 10) {
      guard buffer.distance(from: buffer.startIndex, to: end) <= 12 * 1024 * 1024 else {
        suspend()
        exit(1)
      }
      let data = Data(buffer.prefix(upTo: end))
      buffer.removeSubrange(...end)
      guard let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      else {
        suspend()
        exit(1)
      }
      let generation = integer(message, "executionGeneration")
      switch string(message, "type") {
      case "watchRegister":
        let appId = string(message, "appId")
        let owner = string(message, "owner")
        let accepted = locked {
          guard !appId.isEmpty, !owner.isEmpty,
            targetWatches[appId] != nil || targetWatches.count < 32 else { return false }
          if targetWatches[appId] == nil { targetWatches[appId] = ComputerTargetWatch() }
          targetWatches[appId]?.owners.insert(owner)
          return true
        }
        guard accepted else {
          emit(["type": "response", "requestId": message["requestId"] ?? "",
            "error": ["_tag": "Execution", "message": "Computer target watch limit reached."]])
          continue
        }
        conflictQueue.async {
          refreshWindowCache(); resolveInputs()
        emit(["type": "response", "requestId": message["requestId"] ?? "",
          "result": targetReadiness(appId)])
        }
      case "watchRelease":
        let appId = string(message, "appId")
        let owner = string(message, "owner")
        locked {
          targetWatches[appId]?.owners.remove(owner)
          if targetWatches[appId]?.owners.isEmpty == true { targetWatches.removeValue(forKey: appId) }
        }
      case "availability":
        let appId = message["appId"] as? String
        if let appId, !locked({ targetWatches[appId] != nil }) {
          emit(["type": "response", "requestId": message["requestId"] ?? "",
            "error": ["_tag": "Execution", "message": "Computer target is not watched."]])
          continue
        }
        conflictQueue.async {
          refreshWindowCache(); resolveInputs()
        emit(["type": "response", "requestId": message["requestId"] ?? "",
          "result": targetReadiness(appId)])
        }
      case "permit":
        let duration = Double(integer(message, "expiresInMs")) / 1000
        // The first permit fixes the scope; renewals carry only the generation. A permit with
        // no scope for an unknown generation is the legacy machine-wide foreground lease.
        if message["scope"] != nil, let scope = ComputerExecutionScope(message["scope"]) {
          permits.arm(generation, scope: scope, duration: duration)
        } else if permits.scope(generation) != nil {
          permits.renew(generation, duration: duration)
        } else {
          permits.arm(generation, scope: .foreground, duration: duration)
        }
      case "resume":
        let scope = message["scope"] != nil ? ComputerExecutionScope(message["scope"]) : nil
        if case .app = scope { refreshWindowCache() }
        // A takeover arms against the input sequence Electron observed when the user was idle.
        // Any physical input since then wins: the generation stays suspended and stops.
        if let expected = message["inputSequence"] as? Int,
          locked({ inputSequence }) != expected
        {
          interrupt(generation, ["type": "physicalInput", "cause": "readiness"])
        } else {
          permits.resume(generation, scope: scope)
        }
      case "readiness":
        if let id = message["requestId"] {
          let (age, sequence) = locked {
            (
              lastInputUptime > 0
                ? Int((ProcessInfo.processInfo.systemUptime - lastInputUptime) * 1000) : -1,
              inputSequence
            )
          }
          emit([
            "type": "response", "requestId": id,
            "result": ["inputSequence": sequence, "lastUserInputAgeMs": age],
          ])
        }
      case "suspend":
        if message["executionGeneration"] != nil {
          permits.suspend(generation)
          // Release this generation's input here rather than behind other release work, so
          // one thread's 50 ms acknowledgment never waits on another thread.
          releaseHeldInput(where: { $0.generation == generation })
          if let id = message["requestId"] {
            emit(["type": "response", "requestId": id, "result": [:]])
          }
        } else {
          suspend()
          if let id = message["requestId"] {
            // Acknowledge only after local suspension and held-input release.
            releaseQueue.async { emit(["type": "response", "requestId": id, "result": [:]]) }
          }
        }
      case "retire":
        permits.retire(generation)
        releaseQueue.async { releaseHeldInput(where: { $0.generation == generation }) }
      case "drain":
        // Acknowledged once every earlier mutation on that generation has finished. A
        // generation stuck inside another app reports `drained: false` instead of going silent,
        // so Electron can wait on that one thread rather than kill the shared helper.
        if let id = message["requestId"] {
          DispatchQueue.global().async {
            let deadline = ProcessInfo.processInfo.systemUptime + 5
            while locked({ inFlightByGeneration[generation] ?? 0 }) > 0 {
              if ProcessInfo.processInfo.systemUptime >= deadline {
                emit(["type": "response", "requestId": id, "result": ["drained": false]])
                return
              }
              Thread.sleep(forTimeInterval: 0.01)
            }
            emit(["type": "response", "requestId": id, "result": ["drained": true]])
          }
        }
      case "cancel":
        let id = string(message, "requestId")
        let owner: Int? = locked {
          cancelledRequests.append(id)
          if cancelledRequests.count > 4096 { cancelledRequests.removeFirst() }
          return inFlight[id]
        }
        if let owner { permits.cancel(owner, id: id) }
        // Only that request's held inputs; other generations keep theirs.
        releaseQueue.async { releaseHeldInput(where: { $0.requestId == id }) }
      case "grantsChanged":
        if let auth = message["authorization"] as? [String: Any] {
          stateLock.lock()
          latestGrants[string(auth, "profileId") + "\0" + string(auth, "threadId")] = auth
          stateLock.unlock()
        }
      case "permissions": emitStatus(permissions())
      case "request":
        let request = message["request"] as? [String: Any] ?? [:]
        let op = string(request, "op")
        if ["status", "listApps", "resolveApps", "inspect", "screenshot", "zoom"].contains(op) {
          observeQueue.addOperation { execute(message) }
        } else if isBackground(request) {
          // Background mutations run per app; foreground input stays on one serial queue.
          appQueue(string(request, "appId")).async { execute(message) }
        } else {
          inputQueue.async { execute(message) }
        }
      default:
        suspend()
        exit(1)
      }
    }
    if buffer.count > 12 * 1024 * 1024 {
      suspend()
      exit(1)
    }
  }
  suspend()
  exit(0)
}
RunLoop.main.run()
