import Foundation

/// Observe-only state. It survives retired execution generations and never owns a permit.
/// Callers serialize access and resolve physical input with computerInputConflicts.
public struct ComputerTargetWatch {
  public var owners = Set<String>()
  public private(set) var activityEpoch = 0
  public private(set) var lastActivity: TimeInterval?
  public private(set) var frontmost = false
  public private(set) var pids = Set<Int>()
  public init() {}
  public mutating func activity(now: TimeInterval) {
    activityEpoch += 1
    lastActivity = now
  }
  public mutating func identity(pids: Set<Int>, frontmost: Bool, now: TimeInterval) {
    if self.pids != pids || self.frontmost != frontmost { activity(now: now) }
    self.pids = pids
    self.frontmost = frontmost
  }
  public func activityAgeMs(now: TimeInterval) -> Int {
    lastActivity.map { max(0, Int((now - $0) * 1000)) } ?? -1
  }
}
