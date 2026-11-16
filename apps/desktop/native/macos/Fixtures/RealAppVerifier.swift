import AppKit
import ApplicationServices

// Read-only verification for two known apps. Emit only booleans/state codes,
// never document text, accessibility names/values or window titles. No input,
// activation, permission requests, or reads of provider/F5 state.
let arguments = CommandLine.arguments
let textEditId = "com.apple.TextEdit"
let calculatorId = "com.apple.calculator"
func running(_ id: String) -> NSRunningApplication? {
  NSRunningApplication.runningApplications(withBundleIdentifier: id).first
}
func emit(_ result: [String: Any]) {
  if let bytes = try? JSONSerialization.data(withJSONObject: result) {
    FileHandle.standardOutput.write(bytes)
  }
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  AXUIElementSetMessagingTimeout(element, 0.5)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
    return nil
  }
  return value
}
func application(_ id: String) -> AXUIElement? {
  guard let app = running(id) else { return nil }
  let element = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(element, 0.5)
  return element
}
func focusedWindow(_ app: AXUIElement) -> AXUIElement? {
  guard let value = attribute(app, kAXFocusedWindowAttribute),
    CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(value, to: AXUIElement.self)
}
func ownedDocument(_ window: AXUIElement, _ path: String) -> Bool {
  guard let value = attribute(window, kAXDocumentAttribute) as? String,
    let url = URL(string: value), url.isFileURL else { return false }
  return url.standardizedFileURL.resolvingSymlinksInPath()
    == URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
}
if arguments.contains("--status") {
  emit(["textEditRunning": running(textEditId) != nil,
    "calculatorRunning": running(calculatorId) != nil])
} else if arguments.count == 2 && arguments[1] == "--textedit-has-no-windows" {
  let empty = application(textEditId).flatMap {
    attribute($0, kAXWindowsAttribute) as? [AXUIElement]
  }.map { $0.isEmpty } ?? (running(textEditId) == nil)
  emit(["safeToTerminate": empty])
} else if arguments.count == 3 && arguments[1] == "--verify-document" {
  let app = application(textEditId)
  let window = app.flatMap(focusedWindow)
  emit(["ownedDocumentFocused": window.map { ownedDocument($0, arguments[2]) } ?? false])
} else if arguments.count == 3 && arguments[1] == "--document-state" {
  if running(textEditId) == nil { emit(["documentState": "closed"]) }
  else if let app = application(textEditId),
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] {
    var unknown = false
    let owned = windows.contains { window in
      if ownedDocument(window, arguments[2]) { return true }
      // A standard document window whose document identity is unreadable must
      // not authorize deletion. App dialogs have no document URL.
      if attribute(window, kAXSubroleAttribute) as? String == "AXStandardWindow",
        attribute(window, kAXDocumentAttribute) == nil { unknown = true }
      return false
    }
    emit(["documentState": owned ? "owned-open" : unknown ? "unknown" : "closed"])
  } else { emit(["documentState": "unknown"]) }
} else if arguments.count == 3 && arguments[1] == "--verify-calculator" {
  var found = false
  var complete = true
  var nodes = 0
  let deadline = ProcessInfo.processInfo.systemUptime + 5
  func walk(_ element: AXUIElement, _ depth: Int) {
    guard nodes < 400, depth <= 30, ProcessInfo.processInfo.systemUptime < deadline else {
      complete = false
      return
    }
    nodes += 1
    let role = attribute(element, kAXRoleAttribute) as? String
    guard role != nil else { complete = false; return }
    if role == "AXTextField" || role == "AXStaticText" {
      let value = attribute(element, kAXValueAttribute) as? String
      let title = attribute(element, kAXTitleAttribute) as? String
      found = found || value == arguments[2] || title == arguments[2]
    }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
      for child in children { walk(child, depth + 1) }
    }
  }
  if let app = application(calculatorId), let window = focusedWindow(app) { walk(window, 0) }
  else { complete = false }
  emit(["expectedResultVisible": found && complete, "accessible": complete, "nodes": nodes])
} else {
  emit(["error": "invalid-verifier-operation"])
  exit(2)
}
