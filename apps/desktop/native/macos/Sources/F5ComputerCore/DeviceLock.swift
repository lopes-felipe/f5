import Darwin
import Foundation

/// Isolated provider HOME values must not create independent device locks.
/// Resolve the OS account rather than inheriting the caller's profile home.
public func computerDeviceLockDirectory() -> String? {
  guard let account = getpwuid(getuid()), let home = account.pointee.pw_dir else { return nil }
  return String(cString: home) + "/Library/Application Support/F5"
}

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

/// The request and execution generation that pressed an input.
public struct HeldComputerInputOwner: Hashable {
  public let requestId: String
  public let generation: Int
  public init(requestId: String, generation: Int) {
    self.requestId = requestId
    self.generation = generation
  }
}
/// Used under the helper's input lock. Drain before releasing so cancellation is idempotent.
public struct HeldComputerInputs<Key: Hashable> {
  private var values: [Key: HeldComputerInputOwner?] = [:]
  public init() {}
  public mutating func insert(_ key: Key, owner: HeldComputerInputOwner? = nil) {
    values[key] = owner
  }
  public mutating func remove(_ key: Key) { values.removeValue(forKey: key) }
  public mutating func drain() -> Set<Key> {
    let released = Set(values.keys)
    values.removeAll()
    return released
  }
  /// Release only one request's (or generation's) inputs; unowned inputs always match.
  public mutating func drain(where matches: (HeldComputerInputOwner) -> Bool) -> Set<Key> {
    var released = Set<Key>()
    for (key, owner) in values where owner.map(matches) ?? true {
      released.insert(key)
    }
    for key in released { values.removeValue(forKey: key) }
    return released
  }
}
