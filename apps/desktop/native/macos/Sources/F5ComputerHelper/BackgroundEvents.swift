import AppKit
import ApplicationServices
import Carbon
import F5ComputerCore

/// Values used only for change detection. They are never returned to the caller.
private func eventObservation(_ element: AXUIElement) -> [String: CFTypeRef] {
  var values: [String: CFTypeRef] = [:]
  for name in [kAXValueAttribute, kAXSelectedTextAttribute, kAXSelectedTextRangeAttribute] {
    if let value = attribute(element, name) { values[name] = value }
  }
  for name in [kAXHorizontalScrollBarAttribute, kAXVerticalScrollBarAttribute] {
    if let bar = axElement(attribute(element, name)), let value = attribute(bar, kAXValueAttribute) {
      values[name] = value
    }
  }
  return values
}

/// Process-directed events never move the session cursor or select a foreground app.
/// Only applications certified by real desktop rehearsals are eligible.
func backgroundEvents(_ request: [String: Any], _ host: [String: Any]) throws -> [String: Any] {
  let appId = string(request, "appId")
  guard computerBackgroundEventAppAllowed(appId) else {
    throw Failure("ForegroundRequired", "reason", "unsupported-app")
  }
  let app = try appById(appId)
  let key = string(request, "op") == "key"
  _ = try grant(app, request: request, host: host, needed: key ? "type" : "click")
  try backgroundPreflight(request, app: app)
  let root = applicationElement(app.processIdentifier)
  let element: AXUIElement
  let window: AXUIElement
  if key {
    guard let focused = axElement(attribute(root, kAXFocusedUIElementAttribute)),
      let focusedWindow = axElement(attribute(root, kAXFocusedWindowAttribute))
    else { throw Failure("TargetBlocked", "kind", "focus-unknown") }
    element = focused
    window = focusedWindow
  } else {
    guard request["x"] == nil && request["y"] == nil else { throw Failure("UnsupportedAction") }
    let (snapshot, target, _) = try resolveSnapshotElement(request, app: app)
    element = target
    window = snapshot.window
  }
  var pid: pid_t = 0
  guard AXUIElementGetPid(element, &pid) == .success && pid == app.processIdentifier else {
    throw Failure("TargetBlocked", "kind", "focus-unknown")
  }
  func validate() throws {
    try backgroundPreflight(request, app: app)
    guard let current = axElement(attribute(root, kAXFocusedWindowAttribute)),
      CFEqual(current, window) else { throw Failure("TargetBlocked", "kind", "focus-unknown") }
    let focused = axElement(attribute(root, kAXFocusedUIElementAttribute)) ?? element
    if attribute(focused, kAXRoleAttribute) as? String == "AXSecureTextField" ||
      attribute(focused, kAXSubroleAttribute) as? String == "AXSecureTextField" ||
      IsSecureEventInputEnabled() { throw Failure("TargetBlocked", "kind", "secure-field") }
  }
  try validate()
  let before = eventObservation(element)
  let dispatch = beginBackgroundAction(request, app: app)
  var succeeded = false
  var posted = false
  defer { if !succeeded { try? endBackgroundAction(dispatch, succeeded: false) } }
  do {
  if key {
    let chords = request["chords"] as? [String] ?? []
    guard !chords.isEmpty && chords.count <= 16 &&
      chords.allSatisfy(computerBackgroundKeyAllowed) else {
      throw Failure("ForegroundRequired", "reason", "unsupported-in-background")
    }
    // Build the whole batch before the first post; event creation cannot produce a partial chord.
    let events = try chords.map { raw -> (CGEvent, CGEvent) in
      let (code, flags) = try keyChord(raw)
      guard let down = computerKeyboardEvent(keyCode: code, keyDown: true, modifiers: flags),
        let up = computerKeyboardEvent(keyCode: code, keyDown: false, modifiers: flags)
      else { throw Failure("UnsupportedAction") }
      return (down, up)
    }
    try computerRunEventBatch(count: events.count * max(1, min(20, integer(request, "repeat"))),
      validate: { try validate(); try checkPermit(request) },
      post: { index in
        let (down, up) = events[index % events.count]
        down.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
        up.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
        markActionStarted(request)
        down.postToPid(app.processIdentifier)
        posted = true
        // Always release into this same process, including if input revoked the generation.
        up.postToPid(app.processIdentifier)
      })
  } else {
    guard let frame = axRect(element), !frame.isEmpty,
      let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
        wheel1: -Int32(number(request, "deltaY").rounded(.awayFromZero)), wheel2: -Int32(number(request, "deltaX").rounded(.awayFromZero)), wheel3: 0)
    else { throw Failure("ForegroundRequired", "reason", "unsupported-in-background") }
    _ = try onScreenWindow(window, pid: app.processIdentifier)
    event.location = CGPoint(x: frame.midX, y: frame.midY)
    event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
    try validate()
    _ = try resolveSnapshotElement(request, app: app)
    try checkPermit(request)
    markActionStarted(request)
    event.postToPid(app.processIdentifier)
    posted = true
  }
  } catch {
    if posted { throw Failure("OutcomeUnknown") }
    throw error
  }
  succeeded = true
  try endBackgroundAction(dispatch, succeeded: true)
  Thread.sleep(forTimeInterval: 0.05)
  let after = eventObservation(element)
  let changed = before.contains { name, value in
    after[name].map { !CFEqual(value, $0) } ?? false
  }
  return ["readBack": !before.isEmpty && !after.isEmpty, "verified": changed]
}
