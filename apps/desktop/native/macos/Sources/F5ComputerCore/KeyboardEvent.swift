import CoreGraphics

// Construct marked agent events from private state so a prior chord or physical
// modifier cannot leak into plain Unicode typing. Chord modifiers apply only to
// key-down; key-up also releases their synthetic event state.
public func computerKeyboardEvent(
  keyCode: CGKeyCode, keyDown: Bool, modifiers: CGEventFlags = [], unicode: [UniChar]? = nil
) -> CGEvent? {
  guard let source = CGEventSource(stateID: .privateState),
    let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown)
  else { return nil }
  event.flags = keyDown && unicode == nil ? modifiers : []
  if let unicode {
    unicode.withUnsafeBufferPointer {
      event.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: $0.baseAddress)
    }
  }
  event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
  return event
}

private let computerKeyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "enter": 36, "return": 36,
  "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "tab": 48, "space": 49, "backspace": 51,
  "escape": 53, "esc": 53, "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "minus": 27, "equal": 24, "bracketleft": 33, "bracketright": 30,
  "semicolon": 41, "quote": 39, "comma": 43, "period": 47, "slash": 44,
  "backslash": 42, "backquote": 50,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
]

/// Canonical key names keep safety checks identical across aliases.
public func computerKeyChord(_ raw: String) -> (key: String, code: CGKeyCode, flags: CGEventFlags)?
{
  let aliases = [
    "up": "arrowup", "down": "arrowdown", "left": "arrowleft", "right": "arrowright",
    "esc": "escape", "return": "enter", "-": "minus", "=": "equal", "plus": "equal",
    "[": "bracketleft", "]": "bracketright", ";": "semicolon", "'": "quote",
    ",": "comma", ".": "period", "/": "slash", "\\": "backslash", "`": "backquote",
  ]
  let parts = raw.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(
    String.init)
  guard let last = parts.last else { return nil }
  let key = aliases[last] ?? last
  guard let code = computerKeyCodes[key] else { return nil }
  var flags: CGEventFlags = []
  for part in parts.dropLast() {
    switch part {
    case "meta", "cmd", "command": flags.insert(.maskCommand)
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    default: return nil
    }
  }
  return (key, code, flags)
}
