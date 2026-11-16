import AppKit
import ApplicationServices
import Darwin

// Delivery observations stay local to this synthetic window. The opt-in passive
// tap observes only the fixed stop chord while this fixture is frontmost; system
// shortcut handling can prevent AppKit from delivering that chord to the window.
// Neither observer reads characters, persists key codes, or changes an event.
final class StopFixtureDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var monitor: Any?
  var chordTap: CFMachPort?
  let instruction = NSTextField(labelWithString: "Preparing. Keep the mouse and keyboard idle.")
  let field = NSTextField(frame: NSRect(x: 30, y: 80, width: 600, height: 40))
  var finished = false
  let diagnoseChord = CommandLine.arguments.contains("--diagnose-chord")
  let passiveChord = CommandLine.arguments.contains("--passive-chord")
  func prompt() {
    instruction.stringValue = "Press Control + Command + Escape NOW."
    window.backgroundColor = NSColor.systemRed.withAlphaComponent(0.5)
    emit(["kind": "prompt", "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000])
  }
  func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
  func installChordObserver() -> Bool {
    chordTap = CGEvent.tapCreate(
      tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
      eventsOfInterest: CGEventMask(1) << CGEventType.keyDown.rawValue,
      callback: { _, type, event, context in
        guard let context else { return Unmanaged.passUnretained(event) }
        let delegate = Unmanaged<StopFixtureDelegate>.fromOpaque(context).takeUnretainedValue()
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
          delegate.emit(["kind": "chordMonitor", "available": false,
            "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000])
          return Unmanaged.passUnretained(event)
        }
        guard delegate.window != nil,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
          type == .keyDown,
          event.getIntegerValueField(.eventSourceUserData) != 0xF5C0,
          event.getIntegerValueField(.keyboardEventKeycode) == 53
        else { return Unmanaged.passUnretained(event) }
        if delegate.diagnoseChord {
          delegate.emit(["kind": "chordCandidate", "observer": "session",
            "control": event.flags.contains(.maskControl),
            "command": event.flags.contains(.maskCommand),
            "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000])
        }
        guard event.flags.contains([.maskControl, .maskCommand]) else {
          return Unmanaged.passUnretained(event)
        }
        delegate.emit([
          "kind": "chord", "eventAtMs": Double(event.timestamp) / 1_000_000,
          "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000, "keyDown": true,
        ])
        delegate.showStopped()
        return Unmanaged.passUnretained(event)
      }, userInfo: Unmanaged.passUnretained(self).toOpaque())
    guard let tap = chordTap,
      let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else { return false }
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return CGEvent.tapIsEnabled(tap: tap)
  }
  func showStopped() {
    instruction.stringValue = passiveChord
      ? "Chord observed. Release the keys. No agent input was sent."
      : "Stopped. Release the keys; measuring the final input tail."
    window.backgroundColor = NSColor.systemGreen.withAlphaComponent(0.25)
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    // Failure is reported before activation or typing; never request permissions.
    if CommandLine.arguments.contains("--observe-chord") && !installChordObserver() {
      exit(2)
    }
    window = NSWindow(
      contentRect: NSRect(x: 120, y: 120, width: 660, height: 240),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = passiveChord
      ? "F5 chord observer — no agent input"
      : "F5 physical stop check — synthetic input only"
    window.center()
    instruction.frame = NSRect(x: 30, y: 145, width: 600, height: 55)
    instruction.font = NSFont.systemFont(ofSize: 20)
    instruction.maximumNumberOfLines = 2
    window.contentView!.addSubview(instruction)
    field.setAccessibilityLabel("Rehearsal input")
    window.contentView!.addSubview(field)
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) {
      [weak self] event in
      guard let self, let native = event.cgEvent else { return event }
      let observedAtMs = ProcessInfo.processInfo.systemUptime * 1000
      let marked = native.getIntegerValueField(.eventSourceUserData) == 0xF5C0
      let chord = !marked && event.type == .keyDown && event.keyCode == 53
        && event.modifierFlags.contains([.control, .command])
      if self.diagnoseChord && !marked && event.type == .keyDown && event.keyCode == 53 {
        self.emit(["kind": "chordCandidate", "observer": "window",
          "control": event.modifierFlags.contains(.control),
          "command": event.modifierFlags.contains(.command), "observedAtMs": observedAtMs])
      }
      if chord && self.chordTap != nil { return event }
      self.emit([
        "kind": marked ? "injected" : chord ? "chord" : "physical",
        "eventAtMs": event.timestamp * 1000,
        "observedAtMs": observedAtMs,
        "keyDown": event.type == .keyDown,
      ])
      if chord {
        self.showStopped()
      }
      return event
    }
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(field)
    NSApplication.shared.activate(ignoringOtherApps: true)
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var buffer = Data()
      var bytes = [UInt8](repeating: 0, count: 1024)
      while true {
        let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
        if count <= 0 { break }
        buffer.append(contentsOf: bytes.prefix(count))
        guard buffer.count <= 4096 else { break }
        while let end = buffer.firstIndex(of: 10) {
          let command = String(decoding: buffer.prefix(upTo: end), as: UTF8.self)
          buffer.removeSubrange(...end)
          DispatchQueue.main.async {
            guard let self else { return }
            if command == "COUNTDOWN" || command == "COUNTDOWN_WAIT" {
              self.emit(["kind": "countdown", "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000])
              for seconds in [3, 2, 1] {
                DispatchQueue.main.asyncAfter(deadline: .now() + Double(3 - seconds)) {
                  self.instruction.stringValue = "Get ready: \(seconds)… Wait for RED."
                  self.window.backgroundColor = NSColor.systemYellow.withAlphaComponent(0.25)
                }
              }
              DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                if command == "COUNTDOWN" { self.prompt() }
                else { self.instruction.stringValue = "Ready. Wait for RED." }
              }
            } else if command == "CALIBRATE" {
              self.emit(["kind": "calibration", "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000])
            } else if command == "GO" {
              self.prompt()
            } else if command == "FINISH" {
              self.finished = true
              self.instruction.stringValue = CommandLine.arguments.contains("--observe-chord") && !self.passiveChord
                ? "Input stopped. Verifying pause; keep input idle."
                : "Check complete. You can use your computer again."
              self.emit([
                "kind": "finished", "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000,
                "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
              ])
            }
          }
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      FileHandle.standardOutput.write(Data("FIXTURE_READY\n".utf8))
    }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = StopFixtureDelegate()
if CommandLine.arguments.contains("--probe-chord-monitor") {
  let available = delegate.installChordObserver()
  print(available ? "passive-chord-probe: available" : "passive-chord-probe: unavailable")
  if let tap = delegate.chordTap { CFMachPortInvalidate(tap) }
  exit(available ? 0 : 2)
}
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
