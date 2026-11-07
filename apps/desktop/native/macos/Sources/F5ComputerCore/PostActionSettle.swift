import Foundation

/// Metadata that selects a later target or display must be sampled after settling.
public func computerPostActionSettleMs(
  op: String, screenshot: Bool, appTargeted: Bool, displayCount: Int
) -> Int {
  screenshot || op == "openApp" || op == "activateApp" || !appTargeted || displayCount != 1
    ? 300 : 0
}

/// Bounded polling with injectable monotonic time and sleep for deterministic tests.
public func computerPollUntil(
  timeout: TimeInterval, interval: TimeInterval = 0.025,
  now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
  sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
  cancelled: () -> Bool, predicate: () -> Bool
) -> Bool {
  let deadline = now() + timeout
  while !cancelled() {
    if predicate() { return true }
    let remaining = deadline - now()
    if remaining <= 0 { return false }
    sleep(min(interval, remaining))
  }
  return false
}
