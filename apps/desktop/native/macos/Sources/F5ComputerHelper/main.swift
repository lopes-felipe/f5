import AppKit
import ApplicationServices
import Carbon
import F5ComputerCore
import ScreenCaptureKit

struct Failure: Error {
  let payload: [String: Any]
  init(_ tag: String, _ key: String? = nil, _ value: Any? = nil) {
    var payload: [String: Any] = ["_tag": tag]
    if let key, let value { payload[key] = value }
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
  guard let bytes = try? JSONSerialization.data(withJSONObject: message),
    bytes.count <= 12 * 1024 * 1024
  else { return }
  guard outputSlots.wait(timeout: .now()) == .success else {
    permit.suspend()
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
let permit = ExecutionPermit()
let stateLock = NSLock()
var latestGrants: [String: [String: Any]] = [:]
var pressedKeys = HeldComputerInputs<CGKeyCode>()
var pressedButtons = HeldComputerInputs<Int>()
let inputLock = NSRecursiveLock()
let inputQueue = DispatchQueue(label: "f5.computer.input")
let observeQueue = OperationQueue()
observeQueue.maxConcurrentOperationCount = 2
var eventTap: CFMachPort?
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
  let window: AXUIElement
  let elements: [String: AXUIElement]
}
var snapshots: [String: [Snapshot]] = [:]
let snapshotLock = NSLock()
func releaseHeldInput() {
  inputLock.lock()
  defer { inputLock.unlock() }
  for key in pressedKeys.drain() {
    if let event = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) {
      event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
      event.post(tap: .cghidEventTap)
    }
  }
  let location = CGEvent(source: nil)?.location ?? .zero
  for button in pressedButtons.drain() {
    let b: CGMouseButton = button == 1 ? .right : button == 2 ? .center : .left
    let t: CGEventType = button == 1 ? .rightMouseUp : button == 2 ? .otherMouseUp : .leftMouseUp
    if let event = CGEvent(
      mouseEventSource: nil, mouseType: t, mouseCursorPosition: location, mouseButton: b)
    {
      event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
      event.post(tap: .cghidEventTap)
    }
  }
}
func suspend(_ event: String? = nil) {
  permit.suspend()
  releaseHeldInput()
  if let event { emit(["type": event]) }
}
func permissions() -> [String: Any] {
  let screen = CGPreflightScreenCaptureAccess()
  let accessibility = AXIsProcessTrusted()
  let missing = (screen ? [] : ["screen-recording"]) + (accessibility ? [] : ["accessibility"])
  if !missing.isEmpty {
    return ["available": false, "reason": "missing-permissions", "missing": missing]
  }
  if !monitorHealthy { return ["available": false, "reason": "monitor-unhealthy"] }
  return ["available": true, "displays": displays().map(\.json)]
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
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
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
      if !permit.isSuspended {
        if type == .mouseMoved {
          let now = ProcessInfo.processInfo.systemUptime
          if now - physicalWindowStarted > 0.25 {
            lastPhysicalPoint = event.location
            physicalWindowStarted = now
          }
          if let previous = lastPhysicalPoint,
            hypot(event.location.x - previous.x, event.location.y - previous.y) > 8
          {
            suspend("physicalInput")
          }
        } else {
          suspend("physicalInput")
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
func checkPermit(_ request: [String: Any]) throws {
  let auth = authorization(request)
  guard permit.authorized(integer(auth, "executionGeneration"), id: string(request, "requestId"))
  else { throw Failure("Interrupted", "cause", "permit-expired") }
  guard Date().timeIntervalSince1970 * 1000 < number(request, "deadlineAtMs") else {
    throw Failure("Interrupted", "cause", "permit-expired")
  }
  guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else {
    throw Failure("Unavailable", "reason", "missing-permissions")
  }
  guard monitorHealthy else { throw Failure("Unavailable", "reason", "monitor-unhealthy") }
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
      let right = items.compactMap(axRect).map(\.maxX).max() ?? bounds.minX
      guard computerMenuPointAllowed(x: point.x, left: bounds.minX, lastItemRight: right) else {
        throw Failure("TargetBlocked", "kind", "system-ui")
      }
      _ = try grant(app, request: request, host: host, needed: "click")
      return
    }
  }
  for record in windows() {
    guard let rect = windowRect(record), rect.contains(point),
      number(record, kCGWindowAlpha as String) > 0
    else { continue }
    let pid = integer(record, kCGWindowOwnerPID as String)
    if (host["overlayWindowIds"] as? [Int] ?? []).contains(
      integer(record, kCGWindowNumber as String))
    {
      continue
    }
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
      throw Failure("TargetBlocked", "kind", "owner-unknown")
    }
    _ = try grant(app, request: request, host: host, needed: "click")
    return
  }
  throw Failure("TargetBlocked", "kind", "owner-unknown")
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
    pressedButtons.insert(Int(button.rawValue))
  }
  event.post(tap: .cghidEventTap)
  if [.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) {
    pressedButtons.remove(Int(button.rawValue))
  }
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
  guard
    let window = axElement(attribute(root, kAXFocusedWindowAttribute))
      ?? (attribute(root, kAXWindowsAttribute) as? [AXUIElement])?.first
  else { return ["snapshotId": snapshotId, "appId": id, "accessible": false, "nodes": []] }
  let limit = min(400, max(1, integer(request, "maxNodes")))
  var nodes: [[String: Any]] = []
  var elements: [String: AXUIElement] = [:]
  let inspectDeadline = ProcessInfo.processInfo.systemUptime + 8
  func visit(_ element: AXUIElement, depth: Int) throws {
    if depth > 30 || nodes.count >= limit { return }
    if permit.wasCancelled(string(request, "requestId")) {
      throw Failure("Interrupted", "cause", "paused")
    }
    guard ProcessInfo.processInfo.systemUptime < inspectDeadline,
      Date().timeIntervalSince1970 * 1000 < number(request, "deadlineAtMs")
    else { throw Failure("Execution", "message", "Accessibility observation timed out.") }
    try checkGrants(request)
    let ref = UUID().uuidString
    elements[ref] = element
    let role = attribute(element, kAXRoleAttribute) as? String ?? "unknown"
    let secure =
      role == "AXSecureTextField"
      || (attribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField"
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
    var node: [String: Any] = [
      "elementRef": ref, "role": String(role.prefix(200)),
      "name": String(
        ((attribute(element, kAXTitleAttribute) as? String)
          ?? (attribute(element, kAXDescriptionAttribute) as? String) ?? "").prefix(200)),
      "focused": attribute(element, kAXFocusedAttribute) as? Bool ?? false,
      "enabled": attribute(element, kAXEnabledAttribute) as? Bool ?? true,
      "actions": secure ? [] : actions,
    ]
    if !secure, let value = attribute(element, kAXValueAttribute) as? String {
      node["value"] = String(value.prefix(200))
    }
    if let rect = axRect(element),
      let display = displays().first(where: { $0.bounds.intersects(rect) })
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
    nodes.append(node)
    for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
      if nodes.count >= limit { break }
      try visit(child, depth: depth + 1)
    }
  }
  try visit(window, depth: 0)
  snapshotLock.lock()
  var appSnapshots = snapshots[id] ?? []
  appSnapshots.append(
    Snapshot(id: snapshotId, pid: app.processIdentifier, window: window, elements: elements))
  snapshots[id] = Array(appSnapshots.suffix(4))
  snapshotLock.unlock()
  let result: [String: Any] = [
    "snapshotId": snapshotId, "appId": id, "accessible": true, "nodes": nodes,
  ]
  if (try JSONSerialization.data(withJSONObject: result)).count > 256 * 1024 {
    throw Failure("ResultTooLarge")
  }
  return result
}
func elementAction(_ request: [String: Any], _ host: [String: Any]) throws {
  let id = string(request, "appId")
  let app = try appById(id)
  let action = string(request, "action")
  try checkPermit(request)
  _ = try grant(app, request: request, host: host, needed: action == "setValue" ? "type" : "click")
  snapshotLock.lock()
  let snapshot = snapshots[id]?.first(where: { $0.id == string(request, "snapshotId") })
  snapshotLock.unlock()
  guard let snapshot, snapshot.pid == app.processIdentifier,
    let element = snapshot.elements[string(request, "elementRef")],
    let currentWindow = axElement(
      attribute(applicationElement(app.processIdentifier), kAXFocusedWindowAttribute)),
    CFEqual(currentWindow, snapshot.window)
  else { throw Failure("StaleElement") }
  guard let role = attribute(element, kAXRoleAttribute) as? String else {
    throw Failure("StaleElement")
  }
  if role == "AXSecureTextField"
    || (attribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField"
    || IsSecureEventInputEnabled()
  {
    throw Failure("TargetBlocked", "kind", "secure-field")
  }
  var pid: pid_t = 0
  guard AXUIElementGetPid(element, &pid) == .success && pid == app.processIdentifier else {
    throw Failure("StaleElement")
  }
  try checkPermit(request)
  let result: AXError
  if action == "setValue" || action == "focus" {
    var settable = DarwinBoolean(false)
    let name = action == "focus" ? kAXFocusedAttribute : kAXValueAttribute
    guard
      AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success
        && settable.boolValue
    else { throw Failure("UnsupportedAction") }
    try checkPermit(request)
    result = AXUIElementSetAttributeValue(
      element, name as CFString,
      action == "focus" ? kCFBooleanTrue : string(request, "value") as CFString)
  } else {
    let actions = [
      "press": "AXPress", "increment": "AXIncrement", "decrement": "AXDecrement",
      "showMenu": "AXShowMenu", "scrollIntoView": "AXScrollToVisible",
    ]
    guard let native = actions[action] else { throw Failure("UnsupportedAction") }
    result = AXUIElementPerformAction(element, native as CFString)
  }
  guard result == .success else {
    throw Failure(
      result == .actionUnsupported || result == .attributeUnsupported
        ? "UnsupportedAction" : "StaleElement")
  }
}
func screenshot(_ request: [String: Any], _ host: [String: Any]) async throws -> [String: Any] {
  try checkGrants(request)
  guard CGPreflightScreenCaptureAccess() else {
    throw Failure("Unavailable", "reason", "missing-permissions")
  }
  let target = try display(string(request, "displayId"))
  let grants = authorization(request)["grants"] as? [[String: Any]] ?? []
  let f5Pids = host["f5Pids"] as? [Int] ?? []
  let content: SCShareableContent
  do {
    content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  } catch { throw Failure("Unavailable", "reason", "missing-permissions") }
  let apps = content.applications.filter { app in
    !f5Pids.contains(Int(app.processID)) && tier(app.bundleIdentifier) != "blocked"
      && grants.contains(where: { string($0, "appId") == app.bundleIdentifier })
  }
  guard let screen = content.displays.first(where: { $0.displayID == target.id }) else {
    throw Failure("GeometryChanged")
  }
  let filter = SCContentFilter(display: screen, including: apps, exceptingWindows: [])
  if #available(macOS 14.2, *) {
    filter.includeMenuBar =
      NSWorkspace.shared.frontmostApplication.map { front in
        apps.contains(where: { $0.processID == front.processIdentifier })
      } ?? false
  }
  let zoom = string(request, "op") == "zoom"
  let captureScale = min(1.0, 2560.0 / Double(max(target.pixelWidth, target.pixelHeight)))
  let captureWidth =
    zoom ? max(1, Int(floor(Double(target.pixelWidth) * captureScale))) : target.width
  let captureHeight =
    zoom ? max(1, Int(floor(Double(target.pixelHeight) * captureScale))) : target.height
  let configuration = SCStreamConfiguration()
  configuration.width = captureWidth
  configuration.height = captureHeight
  configuration.showsCursor = false
  let background = CGColor(gray: 0.45, alpha: 1)
  configuration.backgroundColor = background
  let image: CGImage
  do {
    image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: configuration)
  } catch { throw Failure("Unavailable", "reason", "missing-permissions") }
  try checkGrants(request)
  guard try display(String(target.id)).generation == target.generation else {
    throw Failure("GeometryChanged")
  }
  guard
    let canvas = CGContext(
      data: nil, width: captureWidth, height: captureHeight, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw Failure("Execution", "message", "Unable to encode capture.") }
  canvas.setFillColor(CGColor(gray: 0.45, alpha: 1))
  canvas.fill(CGRect(x: 0, y: 0, width: captureWidth, height: captureHeight))
  canvas.draw(image, in: CGRect(x: 0, y: 0, width: captureWidth, height: captureHeight))
  // Mask secure fields; an incomplete tree cannot establish that remaining pixels are safe.
  var maskIncomplete = false
  func fillMask(_ rect: CGRect) {
    let x = (rect.minX - target.bounds.minX) * Double(captureWidth) / target.bounds.width
    let y = (rect.minY - target.bounds.minY) * Double(captureHeight) / target.bounds.height
    let w = rect.width * Double(captureWidth) / target.bounds.width
    let h = rect.height * Double(captureHeight) / target.bounds.height
    canvas.setFillColor(CGColor(gray: 0.45, alpha: 1))
    canvas.fill(
      CGRect(
        x: floor(x), y: Double(captureHeight) - ceil(y + h), width: ceil(w) + 2, height: ceil(h) + 2
      ))
  }
  if let front = NSWorkspace.shared.frontmostApplication,
    apps.contains(where: { $0.processID == front.processIdentifier })
  {
    let root = applicationElement(front.processIdentifier)
    if let window = axElement(attribute(root, kAXFocusedWindowAttribute)) {
      var visited = 0
      let deadline = ProcessInfo.processInfo.systemUptime + 1
      func mask(_ element: AXUIElement, depth: Int) {
        if depth > 30 || visited >= 4000 || ProcessInfo.processInfo.systemUptime >= deadline {
          maskIncomplete = true
          return
        }
        visited += 1
        guard let role = attribute(element, kAXRoleAttribute) as? String else {
          maskIncomplete = true
          return
        }
        if role == "AXSecureTextField"
          || (attribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField"
        {
          if let rect = axRect(element) { fillMask(rect) } else { maskIncomplete = true }
        }
        var children: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(
          element, kAXChildrenAttribute as CFString, &children)
        if status != .success && status != .attributeUnsupported && status != .noValue {
          maskIncomplete = true
        }
        for child in children as? [AXUIElement] ?? [] {
          mask(child, depth: depth + 1)
          if maskIncomplete { break }
        }
      }
      mask(window, depth: 0)
      if maskIncomplete, let rect = axRect(window) { fillMask(rect) }
    } else {
      maskIncomplete = true
    }
    if maskIncomplete {
      for record in windows()
      where integer(record, kCGWindowOwnerPID as String) == Int(front.processIdentifier) {
        if let rect = windowRect(record) { fillMask(rect) }
      }
    }
  }
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
let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "enter": 36, "return": 36,
  "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "tab": 48, "space": 49, "backspace": 51,
  "escape": 53, "esc": 53, "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
]
func keyChord(_ raw: String) throws -> (CGKeyCode, CGEventFlags) {
  let parts = raw.lowercased().split(separator: "+").map(String.init)
  guard let key = parts.last, let code = keyCodes[key] else { throw Failure("UnsupportedAction") }
  var flags: CGEventFlags = []
  for part in parts.dropLast() {
    switch part {
    case "meta", "cmd", "command": flags.insert(.maskCommand)
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    default: throw Failure("UnsupportedAction")
    }
  }
  let cmd = flags.contains(.maskCommand)
  let alt = flags.contains(.maskAlternate)
  let shift = flags.contains(.maskShift)
  let ctrl = flags.contains(.maskControl)
  if blockedComputerChord(key: key, command: cmd, control: ctrl, alt: alt, shift: shift) {
    throw Failure("TargetBlocked", "kind", "system-ui")
  }
  return (code, flags)
}
func mutate(_ request: [String: Any], _ host: [String: Any]) async throws -> [String: Any] {
  let op = string(request, "op")
  try checkPermit(request)
  defer { releaseHeldInput() }
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
          event.post(tap: .cghidEventTap)
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
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else {
              throw Failure("UnsupportedAction")
            }
            units.withUnsafeBufferPointer {
              event.keyboardSetUnicodeString(
                stringLength: units.count, unicodeString: $0.baseAddress!)
            }
            event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
            try checkPermit(request)
            if down { pressedKeys.insert(0) }
            event.post(tap: .cghidEventTap)
            if !down { pressedKeys.remove(0) }
          }
        }
        start = end
        try await Task.sleep(nanoseconds: 10_000_000)
      }
    } else {
      let chords = request["chords"] as? [String] ?? []
      guard !chords.isEmpty && chords.count <= 16 else { throw Failure("UnsupportedAction") }
      for _ in 0..<max(1, min(20, integer(request, "repeat"))) {
        for raw in chords {
          let (code, flags) = try keyChord(raw)
          for down in [true, false] {
            try validateFocus()
            try inputLock.withLock {
              guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
              else { throw Failure("UnsupportedAction") }
              event.flags = flags
              event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
              try checkPermit(request)
              if down { pressedKeys.insert(code) }
              event.post(tap: .cghidEventTap)
              if !down { pressedKeys.remove(code) }
            }
          }
        }
      }
    }
  } else if op == "elementAction" {
    try elementAction(request, host)
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
      guard app.activate(options: []) else {
        throw Failure("Execution", "message", "App activation failed.")
      }
    } else {
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
      let app = try await NSWorkspace.shared.openApplication(
        at: url, configuration: NSWorkspace.OpenConfiguration())
      _ = try grant(app, request: request, host: host, needed: "click")
    }
  } else {
    throw Failure("UnsupportedAction")
  }
  try await Task.sleep(nanoseconds: 300_000_000)
  var result: [String: Any] = [
    "frontmostApp": NSWorkspace.shared.frontmostApplication.flatMap(appRecord) ?? NSNull(),
    "cursor": NSNull(), "actionCompleted": true,
  ]
  if let current = displays().first(where: { String($0.id) == string(request, "displayId") })
    ?? displays().first
  {
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
    if string(capture, "displayId").isEmpty, let app = NSWorkspace.shared.frontmostApplication,
      let window = axElement(
        attribute(applicationElement(app.processIdentifier), kAXFocusedWindowAttribute)),
      let bounds = axRect(window),
      let target = displays().first(where: {
        $0.bounds.contains(CGPoint(x: bounds.midX, y: bounds.midY))
      })
    {
      capture["displayId"] = String(target.id)
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
  let completed = DispatchSemaphore(value: 0)
  Task {
    defer { completed.signal() }
    do {
      let result: Any
      switch op {
      case "status": result = permissions()
      case "listApps": result = protectAppRecords(listApps(), host)
      case "resolveApps":
        result = protectAppRecords(resolveApps(request["queries"] as? [String] ?? []), host)
      case "inspect": result = try inspect(request, host)
      case "screenshot", "zoom": result = try await screenshot(request, host)
      default: result = try await mutate(request, host)
      }
      emit(["type": "response", "requestId": id, "result": result])
    } catch let failure as Failure {
      emit(["type": "response", "requestId": id, "error": failure.payload])
    } catch {
      emit([
        "type": "response", "requestId": id,
        "error": ["_tag": "Execution", "message": "Native action failed."],
      ])
    }
  }
  completed.wait()
}
let lockDirectory = NSHomeDirectory() + "/Library/Application Support/F5"
try FileManager.default.createDirectory(atPath: lockDirectory, withIntermediateDirectories: true)
let deviceLock = ComputerDeviceLock(path: lockDirectory + "/computer-control.lock")
guard deviceLock != nil else {
  emit(["type": "hello", "protocolVersion": 1, "helperVersion": "2.0.0"])
  emit(["type": "status", "status": ["available": false, "reason": "other-instance"]])
  outputQueue.sync {}
  exit(0)
}
emit(["type": "hello", "protocolVersion": 1, "helperVersion": "2.0.0"])
// Child AX objects otherwise retain the default timeout; set the process-wide ceiling.
_ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
installMonitor()
let heartbeat = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
heartbeat.schedule(deadline: .now(), repeating: .milliseconds(250))
heartbeat.setEventHandler {
  if eventTap == nil && AXIsProcessTrusted() { installMonitor() }
  let healthy = eventTap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false
  monitorHealthy = healthy
  if !healthy { suspend() }
  if let generation = permit.takeExpiredGeneration() {
    releaseHeldInput()
    emit(["type": "permitExpired", "executionGeneration": generation])
  }
  if permit.isSuspended { releaseHeldInput() }
  emit(["type": "heartbeat", "monitorHealthy": healthy, "suspended": permit.isSuspended])
  emitStatus(permissions())
}
heartbeat.resume()
DispatchQueue.global(qos: .userInteractive).async {
  var buffer = Data()
  while let chunk = try? FileHandle.standardInput.read(upToCount: 65536), !chunk.isEmpty {
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
      switch string(message, "type") {
      case "permit":
        permit.renew(
          integer(message, "executionGeneration"),
          duration: Double(integer(message, "expiresInMs")) / 1000)
      case "resume": permit.resume(integer(message, "executionGeneration"))
      case "suspend":
        suspend()
        if let id = message["requestId"] {
          emit(["type": "response", "requestId": id, "result": [:]])
        }
      case "cancel":
        permit.cancel(string(message, "requestId"))
        releaseHeldInput()
      case "grantsChanged":
        if let auth = message["authorization"] as? [String: Any] {
          stateLock.lock()
          latestGrants[string(auth, "profileId") + "\0" + string(auth, "threadId")] = auth
          stateLock.unlock()
        }
      case "permissions": emitStatus(permissions())
      case "request":
        let op = string(message["request"] as? [String: Any] ?? [:], "op")
        if ["status", "listApps", "resolveApps", "inspect", "screenshot", "zoom"].contains(op) {
          observeQueue.addOperation { execute(message) }
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
