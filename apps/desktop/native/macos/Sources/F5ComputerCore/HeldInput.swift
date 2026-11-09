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
}

/// One event seen by the session tap, reduced to what held-input tracking needs.
public enum HeldInputEvent: Equatable {
  case down(HeldInput)
  case up(HeldInput)
  /// Pointer movement, scrolling and dragging: activity, never a hold.
  case activity

  /// Maps a tapped event. Modifier direction comes from the event's own flags, never from
  /// toggling, so an edge missed across a tap reset cannot invert later presses.
  public static func from(
    type: CGEventType, keyCode: Int, flags: CGEventFlags, buttonNumber: Int
  ) -> HeldInputEvent {
    switch type {
    case .keyDown:
      return keyCode == HeldInputTracker.capsLockKeyCode
        ? .activity : .down(HeldInput(.key, keyCode))
    case .keyUp: return .up(HeldInput(.key, keyCode))
    case .flagsChanged:
      guard let flag = HeldInputTracker.modifierFlag(keyCode) else { return .activity }
      let key = HeldInput(.modifier, keyCode)
      return flags.contains(flag) ? .down(key) : .up(key)
    case .leftMouseDown: return .down(HeldInput(.button, 0))
    case .rightMouseDown: return .down(HeldInput(.button, 1))
    case .otherMouseDown: return .down(HeldInput(.button, buttonNumber))
    case .leftMouseUp: return .up(HeldInput(.button, 0))
    case .rightMouseUp: return .up(HeldInput(.button, 1))
    case .otherMouseUp: return .up(HeldInput(.button, buttonNumber))
    default: return .activity
    }
  }
}

/// Held physical input, corroborated twice: the session tap saw the down from a HID-system
/// source (not F5's own posts, and not events posted through a private or session source) and
/// the HID system still reports it.
///
/// `CGEventSource` state alone has no owner or age: a key-up lost to sleep, Secure Input or a
/// device disconnect, a virtual device, another tool's posts or Caps Lock's toggle key code
/// reads as "held" forever. Holds the tap never saw going down never count. Corroborated holds
/// keep counting while still down, even without further events: modifiers and stationary
/// buttons repeat nothing. `staleAfter` is only a backstop for HID state stuck after a
/// tap-seen down. Callers serialize access.
public struct HeldInputTracker {
  public struct Entry: Equatable {
    public let since: TimeInterval
    /// Bumped on every new down, so reconciliation never drops a press it did not sample.
    public let revision: Int
  }
  public static let staleAfter: TimeInterval = 120
  public static let reportLimit = 8
  /// `kVK_CapsLock`: a toggle whose key state can read as down while the lock is on.
  public static let capsLockKeyCode = 57
  /// `kCGEventSourceStateHIDSystemState`: the state ID hardware events carry.
  public static let hidSourceStateID: Int64 = 1
  public static let f5UserData: Int64 = 0xF5C0
  public static let fnKeyCode = 63
  public private(set) var downs: [HeldInput: Entry] = [:]
  public private(set) var lastPhysicalInput: TimeInterval?
  private var revision = 0
  public init() {}

  /// Whether a tapped event can be physical input: not F5's own post, and from a HID-system
  /// source. Another process posting through a HID-system source also passes; HID state then
  /// still has to report the hold.
  public static func physical(userData: Int64, sourceStateID: Int64) -> Bool {
    userData != f5UserData && sourceStateID == hidSourceStateID
  }

  /// The device-independent flag a modifier key code sets while down. Caps Lock is a toggle
  /// and is never a hold.
  public static func modifierFlag(_ keyCode: Int) -> CGEventFlags? {
    switch keyCode {
    case 54, 55: .maskCommand
    case 56, 60: .maskShift
    case 58, 61: .maskAlternate
    case 59, 62: .maskControl
    case fnKeyCode: .maskSecondaryFn
    default: nil
    }
  }

  public mutating func observe(_ event: HeldInputEvent, now: TimeInterval) {
    lastPhysicalInput = now
    switch event {
    case .down(let input):
      guard input.code != Self.capsLockKeyCode || input.kind == .button else { return }
      // Auto-repeat keeps the original entry.
      if downs[input] == nil {
        revision += 1
        downs[input] = Entry(since: now, revision: revision)
      }
    case .up(let input):
      downs[input] = nil
    case .activity:
      break
    }
  }

  /// The tap was (re)installed or re-enabled: edges may have been missed while it was down.
  public mutating func reset() {
    downs.removeAll()
    lastPhysicalInput = nil
  }

  /// Entry revisions to check against HID state outside the caller's lock.
  public func sample() -> [HeldInput: Int] { downs.mapValues(\.revision) }

  /// Drops sampled entries the HID system reported released, unless pressed again since the
  /// sample, then returns the corroborated holds, oldest first.
  public mutating func held(
    now: TimeInterval, sampled: [HeldInput: Int], systemHeld: Set<HeldInput>
  ) -> [HeldInput] {
    for (input, revision) in sampled where !systemHeld.contains(input) {
      if downs[input]?.revision == revision { downs[input] = nil }
    }
    guard let last = lastPhysicalInput, now - last <= Self.staleAfter else { return [] }
    return downs.sorted {
      $0.value.since == $1.value.since ? $0.key < $1.key : $0.value.since < $1.value.since
    }
    .prefix(Self.reportLimit).map(\.key)
  }
}
