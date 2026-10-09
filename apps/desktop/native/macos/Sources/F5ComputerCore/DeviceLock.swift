import Darwin
import Foundation

/// The file descriptor, rather than a transient acquisition result, owns the device lock.
public final class ComputerDeviceLock {
  private let descriptor: Int32
  public init?(path: String) {
    let fd = open(path, O_CREAT | O_RDWR, 0o600)
    guard fd >= 0 else { return nil }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      close(fd)
      return nil
    }
    descriptor = fd
  }
  deinit { close(descriptor) }
}

/// Used under the helper's input lock. Drain before releasing so cancellation is idempotent.
public struct HeldComputerInputs<Key: Hashable> {
  private var values = Set<Key>()
  public init() {}
  public mutating func insert(_ key: Key) { values.insert(key) }
  public mutating func remove(_ key: Key) { values.remove(key) }
  public mutating func drain() -> Set<Key> {
    let released = values
    values.removeAll()
    return released
  }
}
