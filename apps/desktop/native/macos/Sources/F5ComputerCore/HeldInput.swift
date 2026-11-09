import CoreGraphics
import Foundation

/// A physical key, modifier key or mouse button the user is holding. Diagnostic codes only:
/// key codes and button numbers, never characters.
public struct HeldInput: Hashable, Comparable {
  public enum Kind: String, Comparable {
    case key, modifier, button
    public static func < (lhs: Kind, rhs: Kind) -> Bool { lhs.rawValue < rhs.rawValue }
  }
  public let kind: Kind
  public let code: Int
  public init(_ kind: Kind, _ code: Int) {
    self.kind = kind
    self.code = code
  }
  public static func < (lhs: HeldInput, rhs: HeldInput) -> Bool {
    lhs.kind == rhs.kind ? lhs.code < rhs.code : lhs.kind < rhs.kind
  }
  public var diagnostic: [String: Any] { ["kind": kind.rawValue, "code": code] }

  /// Whether the HID system reports this input down. `flags` are the HID system's raw modifier
  /// flags; `keyDown` and `buttonDown` read its key and button state.
  public func systemReportsDown(
    flags: UInt64, keyDown: (CGKeyCode) -> Bool, buttonDown: (CGMouseButton) -> Bool
  ) -> Bool {
    switch kind {
    case .key: keyDown(CGKeyCode(code))
    case .modifier: ModifierKey.isDown(code, flags: flags) ?? false
    case .button: CGMouseButton(rawValue: UInt32(code)).map(buttonDown) ?? false
    }
  }
}

/// Modifier key codes and the flag bits that say whether each one is down.
public enum ModifierKey {
  private struct Bits {
    /// The device-dependent bit of this key (`NX_DEVICE*KEYMASK`), so left and right differ.
    let device: UInt64?
    /// Both device-dependent bits of the modifier family.
    let family: UInt64
    /// The device-independent `CGEventFlags` mask.
    let independent: UInt64
  }
  private static func flagBits(_ keyCode: Int) -> Bits? {
    let shift = CGEventFlags.maskShift.rawValue, control = CGEventFlags.maskControl.rawValue
    let option = CGEventFlags.maskAlternate.rawValue, command = CGEventFlags.maskCommand.rawValue
    switch keyCode {
    case 56: return Bits(device: 0x2, family: 0x6, independent: shift)  // kVK_Shift
    case 60: return Bits(device: 0x4, family: 0x6, independent: shift)  // kVK_RightShift
    case 59: return Bits(device: 0x1, family: 0x2001, independent: control)  // kVK_Control
    case 62: return Bits(device: 0x2000, family: 0x2001, independent: control)  // kVK_RightControl
    case 58: return Bits(device: 0x20, family: 0x60, independent: option)  // kVK_Option
    case 61: return Bits(device: 0x40, family: 0x60, independent: option)  // kVK_RightOption
    case 55: return Bits(device: 0x8, family: 0x18, independent: command)  // kVK_Command
    case 54: return Bits(device: 0x10, family: 0x18, independent: command)  // kVK_RightCommand
    case 63:  // kVK_Function: no device-dependent bit.
      return Bits(device: nil, family: 0, independent: CGEventFlags.maskSecondaryFn.rawValue)
    default: return nil  // Caps Lock is a toggle, never a hold; other codes are not modifiers.
    }
  }

  /// Whether the modifier `keyCode` is down in `flags`, or nil when it is not a held modifier.
  /// Uses the key's own left or right bit when the flags carry device-dependent bits for its
  /// family, and the device-independent mask otherwise.
  public static func isDown(_ keyCode: Int, flags: UInt64) -> Bool? {
    guard let bits = flagBits(keyCode) else { return nil }
    if let device = bits.device, flags & bits.family != 0 { return flags & device != 0 }
    return flags & bits.independent != 0
  }
}

/// One event seen by the session tap, reduced to what held-input tracking needs.
public enum HeldInputEvent: Equatable {
  case keyDown(Int)
  case keyUp(Int)
  /// `flagsChanged` for one modifier key code, with its direction read from the event's flags.
  case modifierChanged(Int, down: Bool)
  case buttonDown(Int)
  case buttonUp(Int)
  /// Pointer movement, scrolling and dragging: activity, never a hold.
  case activity

  /// The held-input reading of one tapped event. `buttonNumber` is the event's
  /// `mouseEventButtonNumber` and `flags` its raw flags.
  public init(type: CGEventType, keyCode: Int, buttonNumber: Int, flags: UInt64) {
    switch type {
    case .keyDown: self = .keyDown(keyCode)
    case .keyUp: self = .keyUp(keyCode)
    case .flagsChanged:
      if let down = ModifierKey.isDown(keyCode, flags: flags) {
        self = .modifierChanged(keyCode, down: down)
      } else {
        self = .activity
      }
    case .leftMouseDown: self = .buttonDown(0)
    case .rightMouseDown: self = .buttonDown(1)
    case .otherMouseDown: self = .buttonDown(buttonNumber)
    case .leftMouseUp: self = .buttonUp(0)
    case .rightMouseUp: self = .buttonUp(1)
    case .otherMouseUp: self = .buttonUp(buttonNumber)
    default: self = .activity
    }
  }
}

/// Held physical input, corroborated twice: the session tap saw the down from the HID system
/// (not F5's own post) and the HID system still reports it.
///
/// `CGEventSource` state alone has no owner or age: a key-up lost to sleep, Secure Input or a
/// device disconnect, a virtual device or another automation tool, or Caps Lock's toggle key
/// code reads as "held" forever. Holds the tap never saw going down never count. A corroborated
/// modifier or mouse button counts for as long as the system reports it: those holds send no
/// further events while they last (a held Cmd, a stationary press or paused drag). Ordinary keys
/// repeat while held, so a key hold with no physical input of any kind for `staleAfter` stops
/// counting, a backstop for system key state stuck down. Callers serialize access.
public struct HeldInputTracker {
  /// When a tracked down happened, and a revision that changes whenever the entry is re-added.
  public struct Down: Equatable {
    public let at: TimeInterval
    public let revision: UInt64
  }
  /// Applies to ordinary keys only.
  public static let staleAfter: TimeInterval = 120
  public static let reportLimit = 8
  /// `kVK_CapsLock`: a toggle whose key state can read as down while the lock is on.
  public static let capsLockKeyCode = 57
  /// `kCGEventSourceStateHIDSystemState`: the state ID hardware events carry.
  public static let hidSourceStateID: Int64 = 1
  public static let f5UserData: Int64 = 0xF5C0
  public private(set) var downs: [HeldInput: Down] = [:]
  public private(set) var lastPhysicalInput: TimeInterval?
  private var revision: UInt64 = 0
  public init() {}

  /// Whether a tapped event counts as physical input: not F5's own post, and carrying the HID
  /// system's state ID. Another process posting through a HID-system-state source also passes;
  /// the HID corroboration in `held` still has to agree.
  public static func physical(userData: Int64, sourceStateID: Int64) -> Bool {
    userData != f5UserData && sourceStateID == hidSourceStateID
  }

  public mutating func observe(_ event: HeldInputEvent, now: TimeInterval) {
    lastPhysicalInput = now
    switch event {
    case .keyDown(let code):
      guard code != Self.capsLockKeyCode else { return }
      press(HeldInput(.key, code), now: now)
    case .keyUp(let code):
      downs[HeldInput(.key, code)] = nil
    case .modifierChanged(let code, let down):
      guard code != Self.capsLockKeyCode else { return }
      if down { press(HeldInput(.modifier, code), now: now) } else {
        downs[HeldInput(.modifier, code)] = nil
      }
    case .buttonDown(let button):
      press(HeldInput(.button, button), now: now)
    case .buttonUp(let button):
      downs[HeldInput(.button, button)] = nil
    case .activity:
      break
    }
  }

  /// A repeated down keeps the original entry, its time and its revision.
  private mutating func press(_ input: HeldInput, now: TimeInterval) {
    guard downs[input] == nil else { return }
    revision += 1
    downs[input] = Down(at: now, revision: revision)
  }

  /// The tap was (re)installed or re-enabled: edges may have been missed while it was down.
  public mutating func reset() {
    downs.removeAll()
    lastPhysicalInput = nil
  }

  /// Holds the tap saw and the HID system still reports, oldest first. `released` maps entries
  /// sampled from `downs` that the system then reported released to their sampled revision.
  /// Each is dropped only if unchanged since sampling, so a release and re-press between the
  /// sample and this call keeps the new hold.
  public mutating func held(now: TimeInterval, released: [HeldInput: UInt64]) -> [HeldInput] {
    for (input, sampled) in released where downs[input]?.revision == sampled {
      downs[input] = nil
    }
    let keysStale = lastPhysicalInput.map { now - $0 > Self.staleAfter } ?? true
    return downs.filter { !(keysStale && $0.key.kind == .key) }
      .sorted { $0.value.at == $1.value.at ? $0.key < $1.key : $0.value.at < $1.value.at }
      .prefix(Self.reportLimit).map(\.key)
  }
}
