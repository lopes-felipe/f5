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
}

/// One event seen by the session tap, reduced to what held-input tracking needs.
public enum HeldInputEvent: Equatable {
  case keyDown(Int)
  case keyUp(Int)
  /// `flagsChanged` for one modifier key code. Each press and each release produce one.
  case modifierChanged(Int)
  case buttonDown(Int)
  case buttonUp(Int)
  /// Pointer movement, scrolling and dragging: activity, never a hold.
  case activity
}

/// Held physical input, corroborated twice: the session tap saw the down (from a hardware
/// source, not F5 or another process's synthetic post) and the HID system still reports it.
///
/// `CGEventSource` state alone has no owner or age: a key-up lost to sleep, Secure Input or a
/// device disconnect, a virtual device or another automation tool, or Caps Lock's toggle key
/// code reads as "held" forever. Holds the tap never saw going down never count, and a hold
/// with no physical input of any kind for `staleAfter` stops counting: real key holds repeat
/// and real drags move. Callers serialize access.
public struct HeldInputTracker {
  public static let staleAfter: TimeInterval = 10
  public static let reportLimit = 8
  /// `kVK_CapsLock`: a toggle whose key state can read as down while the lock is on.
  public static let capsLockKeyCode = 57
  /// `kCGEventSourceStateHIDSystemState`: the state ID hardware events carry.
  public static let hidSourceStateID: Int64 = 1
  public static let f5UserData: Int64 = 0xF5C0
  public private(set) var downs: [HeldInput: TimeInterval] = [:]
  public private(set) var lastPhysicalInput: TimeInterval?
  public init() {}

  /// Whether a tapped event is physical input: not F5's own post, and from the HID system.
  public static func physical(userData: Int64, sourceStateID: Int64) -> Bool {
    userData != f5UserData && sourceStateID == hidSourceStateID
  }

  public mutating func observe(_ event: HeldInputEvent, now: TimeInterval) {
    lastPhysicalInput = now
    switch event {
    case .keyDown(let code):
      guard code != Self.capsLockKeyCode else { return }
      let key = HeldInput(.key, code)
      if downs[key] == nil { downs[key] = now }
    case .keyUp(let code):
      downs[HeldInput(.key, code)] = nil
    case .modifierChanged(let code):
      guard code != Self.capsLockKeyCode else { return }
      let key = HeldInput(.modifier, code)
      // Press and release alternate per key code; a missed edge is corrected by `held`.
      downs[key] = downs[key] == nil ? now : nil
    case .buttonDown(let button):
      let key = HeldInput(.button, button)
      if downs[key] == nil { downs[key] = now }
    case .buttonUp(let button):
      downs[HeldInput(.button, button)] = nil
    case .activity:
      break
    }
  }

  /// The tap was (re)installed or re-enabled: edges may have been missed while it was down.
  public mutating func reset() {
    downs.removeAll()
    lastPhysicalInput = nil
  }

  /// Holds the tap saw and the HID system (`systemHeld`) still reports, oldest first.
  /// Entries the system reports released are dropped; stale holds are kept but not reported.
  public mutating func held(now: TimeInterval, systemHeld: (HeldInput) -> Bool) -> [HeldInput] {
    downs = downs.filter { systemHeld($0.key) }
    guard let last = lastPhysicalInput, now - last <= Self.staleAfter else { return [] }
    return downs.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value < $1.value }
      .prefix(Self.reportLimit).map(\.key)
  }
}
