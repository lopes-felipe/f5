import AppKit

// Synthetic content only. The rehearsal launches this temporary app and grants
// no existing user app. Its editable and secure fields exercise real AX behavior.
final class FixtureDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  let counter = NSTextField(labelWithString: "presses: 0")
  let secure = NSSecureTextField(frame: NSRect(x: 30, y: 150, width: 400, height: 28))
  var presses = 0
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 120, y: 120, width: 500, height: 300),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Computer Control Test Fixture"
    window.center()
    let content = window.contentView!
    let field = NSTextField(frame: NSRect(x: 30, y: 205, width: 400, height: 28))
    field.setAccessibilityLabel("Rehearsal input")
    content.addSubview(field)
    secure.stringValue = "SYNTHETIC_SECURE_SENTINEL"
    secure.setAccessibilityLabel("Rehearsal secure field")
    content.addSubview(secure)
    let button = NSButton(title: "Rehearsal press", target: self, action: #selector(press))
    button.frame = NSRect(x: 30, y: 90, width: 180, height: 32)
    content.addSubview(button)
    let focusSecure = NSButton(
      title: "Focus secure", target: self, action: #selector(focusSecureField))
    focusSecure.frame = NSRect(x: 230, y: 90, width: 180, height: 32)
    content.addSubview(focusSecure)
    counter.frame = NSRect(x: 30, y: 40, width: 400, height: 28)
    content.addSubview(counter)
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(field)
    NSApplication.shared.activate(ignoringOtherApps: true)
  }
  @objc func press() {
    presses += 1
    counter.stringValue = "presses: \(presses)"
  }
  @objc func focusSecureField() { window.makeFirstResponder(secure) }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = FixtureDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
