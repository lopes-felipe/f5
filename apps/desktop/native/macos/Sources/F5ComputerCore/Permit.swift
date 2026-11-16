import Foundation

public final class ExecutionPermit {
  private let lock = NSLock()
  private var generation = 0
  private var expires: TimeInterval = 0
  private var suspended = true
  private var expiredGeneration: Int?
  private var cancelled = Set<String>()
  public init() {}
  public func renew(
    _ generation: Int, duration: TimeInterval,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) {
    lock.lock()
    defer { lock.unlock() }
    if generation < self.generation { return }
    if now >= expires { expire() }
    if generation != self.generation {
      suspended = true
      cancelled.removeAll()
    }
    self.generation = generation
    expires = now + min(1, max(0, duration))
  }
  public func resume(_ generation: Int, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
    lock.lock()
    defer { lock.unlock() }
    if generation == self.generation && now < expires { suspended = false }
  }
  public func suspend() {
    lock.lock()
    suspended = true
    lock.unlock()
  }
  public func cancel(_ id: String) {
    lock.lock()
    cancelled.insert(id)
    lock.unlock()
  }
  public func wasCancelled(_ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled.contains(id)
  }
  public func authorized(
    _ generation: Int, id: String, now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if now >= expires { expire() }
    return !suspended && generation == self.generation && !cancelled.contains(id)
  }
  private func expire() {
    if !suspended { expiredGeneration = generation }
    suspended = true
  }
  public func takeExpiredGeneration() -> Int? {
    lock.lock()
    defer { lock.unlock() }
    if ProcessInfo.processInfo.systemUptime >= expires { expire() }
    let result = expiredGeneration
    expiredGeneration = nil
    return result
  }
  public var isSuspended: Bool {
    lock.lock()
    defer { lock.unlock() }
    if ProcessInfo.processInfo.systemUptime >= expires { expire() }
    return suspended
  }
}
public func modelSize(width: Int, height: Int) -> (Int, Int) {
  let scale = min(
    1, 1456 / Double(max(width, height)), sqrt(1_150_000 / (Double(width) * Double(height))))
  return (max(1, Int(floor(Double(width) * scale))), max(1, Int(floor(Double(height) * scale))))
}

public func zoomPixelBounds(
  x: Int, y: Int, width: Int, height: Int, modelWidth: Int, modelHeight: Int, captureWidth: Int,
  captureHeight: Int
) -> (x: Int, y: Int, width: Int, height: Int)? {
  guard x >= 0, y >= 0, width > 0, height > 0, modelWidth > 0, modelHeight > 0, captureWidth > 0,
    captureHeight > 0, width <= modelWidth, height <= modelHeight, x <= modelWidth - width,
    y <= modelHeight - height
  else { return nil }
  let left = Int(floor(Double(x) * Double(captureWidth) / Double(modelWidth)))
  let top = Int(floor(Double(y) * Double(captureHeight) / Double(modelHeight)))
  let right = min(
    captureWidth, Int(ceil(Double(x + width) * Double(captureWidth) / Double(modelWidth))))
  let bottom = min(
    captureHeight, Int(ceil(Double(y + height) * Double(captureHeight) / Double(modelHeight))))
  return (left, top, right - left, bottom - top)
}
