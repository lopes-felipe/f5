import AppKit

final class DelayedInputField: NSTextField {
  override func becomeFirstResponder() -> Bool {
    if CommandLine.arguments.contains("--delayed-focus") { Thread.sleep(forTimeInterval: 0.2) }
    return super.becomeFirstResponder()
  }
  override func keyDown(with event: NSEvent) {
    if CommandLine.arguments.contains("--delayed-focus") { Thread.sleep(forTimeInterval: 0.2) }
    super.keyDown(with: event)
  }
}

// Synthetic content only. The rehearsal launches this temporary app and grants
// no existing user app. Its editable and secure fields exercise real AX behavior.
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
  var window: NSWindow!
  let counter = NSTextField(labelWithString: "presses: 0")
  let secure = NSSecureTextField(frame: NSRect(x: 30, y: 150, width: 400, height: 28))
  var presses = 0
  let instruction = NSTextField(labelWithString: "Follow the F5 test instructions.")
  var finishButton: NSButton!
  var inputField: NSTextField!
  var delayedButton: NSButton?
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 120, y: 120, width: 500, height: 300),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Computer Control Test Fixture"
    let requestedDisplayIndex = CommandLine.arguments.firstIndex(of: "--display-id")
    let requestedScreen: NSScreen?
    if let index = requestedDisplayIndex {
      guard index + 1 < CommandLine.arguments.count,
        let number = UInt32(CommandLine.arguments[index + 1]),
        let selected = NSScreen.screens.first(where: {
          ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == number
        })
      else { NSApplication.shared.terminate(nil); return }
      requestedScreen = selected
      window.setFrameOrigin(NSPoint(x: selected.visibleFrame.midX - window.frame.width / 2,
        y: selected.visibleFrame.midY - window.frame.height / 2))
    } else {
      requestedScreen = nil
      window.center()
    }
    let content = window.contentView!
    let ungranted = CommandLine.arguments.contains("--ungranted")
    let marker = NSBox(frame: NSRect(x: 30, y: 260, width: 400, height: 24))
    marker.boxType = .custom
    marker.borderType = .noBorder
    marker.fillColor = ungranted ? NSColor.green : NSColor.blue
    marker.setAccessibilityElement(true)
    marker.setAccessibilityLabel("Rehearsal capture marker")
    content.addSubview(marker)
    if ungranted, let screen = requestedScreen ?? NSScreen.main {
      window.setFrameOrigin(NSPoint(x: screen.visibleFrame.minX + 20, y: window.frame.minY))
    }
    let field = DelayedInputField(frame: NSRect(x: 30, y: 205, width: 400, height: 28))
    inputField = field
    field.setAccessibilityLabel("Rehearsal input")
    field.delegate = self
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
    instruction.frame = NSRect(x: 30, y: 4, width: 310, height: 28)
    instruction.setAccessibilityLabel("Rehearsal instruction")
    content.addSubview(instruction)
    finishButton = NSButton(title: "Finish check", target: self, action: #selector(acknowledge))
    finishButton.frame = NSRect(x: 350, y: 4, width: 120, height: 28)
    finishButton.isEnabled = false
    content.addSubview(finishButton)
    if let index = CommandLine.arguments.firstIndex(of: "--tree-nodes"),
      index + 1 < CommandLine.arguments.count,
      let count = Int(CommandLine.arguments[index + 1]), (1...800).contains(count)
    {
      for item in 0..<count {
        let label = NSTextField(labelWithString: "Fixture node \(item)")
        label.setAccessibilityLabel("Fixture node \(item)")
        label.frame = NSRect(x: 5 + (item % 20) * 24, y: 35 + (item / 20) * 5, width: 22, height: 5)
        content.addSubview(label)
      }
    }
    DispatchQueue.global(qos: .utility).async { [weak self] in
      while let line = readLine() {
        guard line.count <= 128 else { return }
        if ["PERF_RESET", "PERF_VERIFY", "PERF_DELAY_BUTTON"].contains(line) {
          DispatchQueue.main.async {
            guard let self else { return }
            if line == "PERF_RESET" {
              self.presses = 0
              self.counter.stringValue = "presses: 0"
              self.inputField.stringValue = ""
              self.delayedButton?.removeFromSuperview()
              self.delayedButton = nil
              FileHandle.standardOutput.write(Data("FIXTURE_RESET\n".utf8))
            } else if line == "PERF_VERIFY" {
              let facts: [String: Any] = [
                "presses": self.presses, "hasInput": !self.inputField.stringValue.isEmpty,
                "delayedButton": self.delayedButton != nil,
              ]
              if let data = try? JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys]) {
                FileHandle.standardOutput.write(data + Data("\n".utf8))
              }
            } else {
              DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                let button = NSButton(title: "Delayed ready", target: self, action: #selector(self.press))
                button.frame = NSRect(x: 30, y: 240, width: 180, height: 22)
                self.window.contentView?.addSubview(button)
                self.delayedButton = button
              }
            }
          }
          continue
        }
        let instructions = [
          "WINDOWLESS_READY": "Ready. Keep input idle.",
          "WINDOWLESS_COUNTDOWN_3": "Starting in 3. Keep input idle.",
          "WINDOWLESS_COUNTDOWN_2": "Starting in 2. Keep input idle.",
          "WINDOWLESS_COUNTDOWN_1": "Starting in 1. Keep input idle.",
          "WINDOWLESS_RUNNING": "RED — running. Keep input idle.",
          "WINDOWLESS_FINISHED": "Finished. Click Finish check.",
          "PROFILE_HOLD": "RED — Isolation waiting. Keep idle.",
          "PROFILE_RELEASE": "Isolation released — keep input idle.",
        ]
        guard let message = instructions[line] else { continue }
        DispatchQueue.main.async {
          guard let self else { return }
          self.instruction.stringValue = message
          self.instruction.textColor = (line == "WINDOWLESS_RUNNING" || line == "PROFILE_HOLD") ? .systemRed : .labelColor
          self.finishButton.isEnabled = line == "WINDOWLESS_FINISHED"
        }
      }
    }
    let background = CommandLine.arguments.contains("--background")
    if background { window.orderBack(nil) } else { window.makeKeyAndOrderFront(nil) }
    window.makeFirstResponder(field)
    if !background { NSApplication.shared.activate(ignoringOtherApps: true) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      FileHandle.standardOutput.write(Data("FIXTURE_READY\n".utf8))
    }
  }
  @objc func press() {
    presses += 1
    counter.stringValue = "presses: \(presses)"
    FileHandle.standardOutput.write(Data("FIXTURE_PRESSED\n".utf8))
  }
  func controlTextDidChange(_ notification: Notification) {
    guard let index = CommandLine.arguments.firstIndex(of: "--expected-text"),
      index + 1 < CommandLine.arguments.count,
      let field = notification.object as? NSTextField,
      field.stringValue == CommandLine.arguments[index + 1]
    else { return }
    // Only a boolean observation leaves the fixture, never the typed content.
    FileHandle.standardOutput.write(Data("FIXTURE_TYPED\n".utf8))
  }
  @objc func focusSecureField() { window.makeFirstResponder(secure) }
  func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
    guard commandSelector == #selector(NSResponder.insertNewline(_:)),
      let index = CommandLine.arguments.firstIndex(of: "--expected-text"),
      index + 1 < CommandLine.arguments.count else { return false }
    if inputField.stringValue == CommandLine.arguments[index + 1] {
      FileHandle.standardOutput.write(Data("FIXTURE_ENTERED\n".utf8))
    }
    return true
  }
  @objc func acknowledge() {
    guard finishButton.isEnabled, let event = NSApplication.shared.currentEvent,
      event.type == .leftMouseUp, let cgEvent = event.cgEvent,
      cgEvent.getIntegerValueField(.eventSourceUserData) != 0xF5C0 else { return }
    finishButton.isEnabled = false
    instruction.stringValue = "Finished. You can use your computer."
    FileHandle.standardOutput.write(Data("FIXTURE_ACKNOWLEDGED\n".utf8))
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = FixtureDelegate()
application.delegate = delegate
application.setActivationPolicy(
  CommandLine.arguments.contains("--background") ? .accessory : .regular)
application.run()
