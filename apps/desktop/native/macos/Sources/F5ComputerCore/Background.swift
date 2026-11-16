import CoreGraphics
import Foundation

/// The lease scope Electron armed for one execution generation. Immutable per generation.
public enum ComputerExecutionScope: Equatable {
  case foreground
  case app(String)
  case takeover(String)

  /// Protocol decoding. A missing scope is the legacy machine-wide foreground lease.
  public init?(_ value: Any?) {
    guard let object = value as? [String: Any] else {
      if value == nil { self = .foreground } else { return nil }
      return
    }
    let appId = object["appId"] as? String ?? ""
    switch object["kind"] as? String {
    case "foreground": self = .foreground
    case "app" where !appId.isEmpty: self = .app(appId)
    case "takeover" where !appId.isEmpty: self = .takeover(appId)
    default: return nil
    }
  }
  public var appId: String? {
    switch self {
    case .foreground: return nil
    case .app(let id), .takeover(let id): return id
    }
  }
  public var isBackground: Bool {
    if case .app = self { return true }
    return false
  }
}

/// Operations a background generation may execute through accessibility alone.
/// Mirrors `computerBackgroundOpAllowed` in packages/shared/src/computerExecution.ts.
public func computerBackgroundOpAllowed(op: String, action: String?, events: Bool = false) -> Bool {
  switch op {
  case "status", "listApps", "resolveApps", "inspect", "screenshot", "zoom", "type", "openApp":
    return true
  case "elementAction": return action == "press" || action == "setValue"
  case "key", "scroll": return events
  default: return false
  }
}

/// Background requires `app(appId)` and a background op; foreground requires the legacy
/// scope or a takeover of the same app; activation is foreground only.
public func computerScopeAllows(
  scope: ComputerExecutionScope, delivery: String, op: String, appId: String?, action: String?
) -> Bool {
  if delivery == "background" {
    guard case .app(let scoped) = scope, appId == scoped, op != "activateApp" else { return false }
    return computerBackgroundOpAllowed(op: op, action: action,
      events: appId.map(computerBackgroundEventAppAllowed) ?? false)
  }
  switch scope {
  case .foreground: return true
  case .app: return false
  case .takeover(let scoped): return appId == nil || appId == scoped
  }
}

public enum ComputerInputKind {
  case pointerDown
  case scroll
  case dragStart
  case drop
  case keyDown
  case pointerMove
}

/// Whether one physical input conflicts with a background generation. Pointer-down, scroll and
/// drag/drop into a target window conflict; conservatively, so does input inside a target's
/// cached bounds when the owner is unknown or the cache is stale. Key-down conflicts only when
/// the target is frontmost. Moves never conflict.
public func computerInputConflicts(
  kind: ComputerInputKind, location: CGPoint, eventWindowOwnerPid: Int?, cachedOwnerAtPoint: Int?,
  frontmostPid: Int?, targetPids: Set<Int>, targetBounds: [CGRect], cacheFresh: Bool
) -> Bool {
  switch kind {
  case .pointerMove: return false
  case .keyDown: return frontmostPid.map(targetPids.contains) ?? false
  case .pointerDown, .scroll, .dragStart, .drop:
    let owner = eventWindowOwnerPid ?? (cacheFresh ? cachedOwnerAtPoint : nil)
    if let owner { return targetPids.contains(owner) }
    return targetBounds.contains { $0.contains(location) }
  }
}

/// An activation incident: the target became frontmost because of a dispatched background
/// action, within the tracking window (500 ms after the action completed).
public func computerActivationIncident(
  beforePid: Int?, afterPid: Int?, targetPid: Int, windowEndUptime: TimeInterval,
  now: TimeInterval
) -> Bool {
  now <= windowEndUptime && beforePid != targetPid && afterPid == targetPid
}

/// Per-generation execution permits. Generations start suspended, expire after one second
/// without renewal, and once retired can never be renewed or resumed again.
public final class ExecutionPermits {
  private struct Entry {
    var expires: TimeInterval
    var suspended = true
    var interruptionCause: String?
    var scope: ComputerExecutionScope
    var cancelled = Set<String>()
  }
  private let lock = NSLock()
  private var entries: [Int: Entry] = [:]
  private var retired: [Int] = []
  private var retiredSet = Set<Int>()
  private var expired: [Int] = []
  private let retiredLimit: Int
  public init(retiredLimit: Int = 1024) { self.retiredLimit = retiredLimit }

  /// Arm (first permit, fixing the scope) or renew a generation. A different scope for an
  /// existing generation is refused: scopes are immutable per generation.
  public func arm(
    _ generation: Int, scope: ComputerExecutionScope, duration: TimeInterval,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) {
    lock.lock()
    defer { lock.unlock() }
    guard generation > 0, !retiredSet.contains(generation) else { return }
    if let existing = entries[generation], existing.scope != scope { return }
    renewLocked(generation, scope: scope, duration: duration, now: now)
  }
  /// Renewals carry only the generation; they never create a generation or change its scope.
  public func renew(
    _ generation: Int, duration: TimeInterval,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) {
    lock.lock()
    defer { lock.unlock() }
    guard entries[generation] != nil else { return }
    renewLocked(generation, scope: nil, duration: duration, now: now)
  }
  private func renewLocked(
    _ generation: Int, scope: ComputerExecutionScope?, duration: TimeInterval, now: TimeInterval
  ) {
    let expires = now + min(1, max(0, duration))
    if var entry = entries[generation] {
      if now >= entry.expires { expire(generation, &entry) }
      entry.expires = expires
      entries[generation] = entry
    } else if let scope {
      entries[generation] = Entry(expires: expires, scope: scope)
    }
  }
  /// Resume only an unexpired generation whose scope matches (when stated).
  public func resume(
    _ generation: Int, scope: ComputerExecutionScope? = nil,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) {
    lock.lock()
    defer { lock.unlock() }
    guard var entry = entries[generation], now < entry.expires else { return }
    if let scope, scope != entry.scope { return }
    entry.suspended = false
    entry.interruptionCause = nil
    entries[generation] = entry
  }
  public func suspend(_ generation: Int, cause: String? = nil) {
    lock.lock()
    entries[generation]?.suspended = true
    if let cause { entries[generation]?.interruptionCause = cause }
    lock.unlock()
  }
  public func interruptionCause(_ generation: Int) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return entries[generation]?.interruptionCause
  }
  public func suspendAll() {
    lock.lock()
    for key in entries.keys { entries[key]?.suspended = true }
    lock.unlock()
  }
  /// Suspend only background generations (monitor overflow / unresolvable ownership).
  public func suspendBackground() -> [Int] {
    lock.lock()
    defer { lock.unlock() }
    var suspended: [Int] = []
    for (key, entry) in entries where entry.scope.isBackground && !entry.suspended {
      entries[key]?.suspended = true
      suspended.append(key)
    }
    return suspended
  }
  /// Suspend foreground/takeover generations; returns those that were active.
  public func suspendForeground(cause: String? = nil) -> [Int] {
    lock.lock()
    defer { lock.unlock() }
    var suspended: [Int] = []
    for (key, entry) in entries where !entry.scope.isBackground && !entry.suspended {
      entries[key]?.suspended = true
      entries[key]?.interruptionCause = cause
      suspended.append(key)
    }
    return suspended
  }
  public func retire(_ generation: Int) {
    lock.lock()
    defer { lock.unlock() }
    entries.removeValue(forKey: generation)
    guard generation > 0, !retiredSet.contains(generation) else { return }
    retired.append(generation)
    retiredSet.insert(generation)
    if retired.count > retiredLimit { retiredSet.remove(retired.removeFirst()) }
  }
  public func cancel(_ generation: Int, id: String) {
    lock.lock()
    entries[generation]?.cancelled.insert(id)
    lock.unlock()
  }
  public func wasCancelled(_ generation: Int, id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return entries[generation].map { $0.cancelled.contains(id) } ?? true
  }
  public func authorized(
    _ generation: Int, id: String, now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard var entry = entries[generation] else { return false }
    if now >= entry.expires {
      expire(generation, &entry)
      entries[generation] = entry
    }
    return !entry.suspended && !entry.cancelled.contains(id)
  }
  public func scope(_ generation: Int) -> ComputerExecutionScope? {
    lock.lock()
    defer { lock.unlock() }
    return entries[generation]?.scope
  }
  /// Generations that expired while active; each is reported once.
  public func takeExpiredGenerations(now: TimeInterval = ProcessInfo.processInfo.systemUptime)
    -> [Int]
  {
    lock.lock()
    defer { lock.unlock() }
    for (key, var entry) in entries where now >= entry.expires {
      expire(key, &entry)
      entries[key] = entry
    }
    let result = expired
    expired.removeAll()
    return result
  }
  /// Active (unsuspended, unexpired) generations and their scopes.
  public func activeGenerations(now: TimeInterval = ProcessInfo.processInfo.systemUptime)
    -> [Int: ComputerExecutionScope]
  {
    lock.lock()
    defer { lock.unlock() }
    var result: [Int: ComputerExecutionScope] = [:]
    for (key, entry) in entries where !entry.suspended && now < entry.expires {
      result[key] = entry.scope
    }
    return result
  }
  public var isSuspended: Bool { activeGenerations().isEmpty }
  private func expire(_ generation: Int, _ entry: inout Entry) {
    if !entry.suspended { expired.append(generation) }
    entry.suspended = true
    entry.interruptionCause = "permit-expired"
  }
}
