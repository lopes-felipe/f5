import Foundation

/// Traversal and element ancestry validation must support the same maximum path length.
public let computerInspectMaxVisited = 4000

/// Reserve 64 KiB for snapshot metadata and envelope fields beneath the 512 KiB hard limit.
public struct ComputerInspectByteBudget {
  private var bytes = 0
  public private(set) var exceeded = false
  private let limit = 448 * 1024
  public init() {}
  /// A rejected node gets no ref; callers return their accepted nodes with `truncated`.
  public mutating func include(_ node: [String: Any]) throws -> Bool {
    let size = try JSONSerialization.data(withJSONObject: node).count + 1
    guard !exceeded, size <= limit - bytes else {
      exceeded = true
      return false
    }
    bytes += size
    return true
  }
}

/// Validate deep inspected controls while bounding work and terminating parent cycles.
public func computerHasAncestor<Handle: Hashable>(
  ancestor: Handle, element: Handle, parent: (Handle) throws -> Handle?
) rethrows -> Bool {
  var current: Handle? = element
  var seen: Set<Handle> = []
  for _ in 0..<computerInspectMaxVisited {
    guard let node = current, seen.insert(node).inserted else { return false }
    if node == ancestor { return true }
    current = try parent(node)
  }
  return false
}

/// Keep eight snapshots per owner/session and a bounded total for the app. One active thread
/// cannot evict another thread's refs merely by taking several trailing or subtree snapshots.
public func computerRetainSnapshots<Value>(_ snapshots: [Value], owner: (Value) -> String)
  -> [Value]
{
  var counts: [String: Int] = [:]
  let kept = snapshots.reversed().filter { snapshot in
    let key = owner(snapshot)
    let count = counts[key, default: 0]
    guard count < 8 else { return false }
    counts[key] = count + 1
    return true
  }
  return Array(kept.prefix(32).reversed())
}

/// Unnamed structural wrappers do not spend the emitted-node budget. Chrome exposes the
/// two weak actions even on otherwise empty groups, so they do not make a wrapper useful.
public func computerInspectIsWrapper(
  role: String, name: String, value: String?, focused: Bool, actions: [String]
) -> Bool {
  ["AXGroup", "AXUnknown", "AXGenericElement"].contains(role) && name.isEmpty
    && (value?.isEmpty ?? true) && !focused
    && actions.allSatisfy { ["showMenu", "scrollIntoView"].contains($0) }
}

/// A row container with at least this many children would spend most of the visited budget on
/// its rows (about four nodes each) before the rest of the window is reached.
public let computerInspectLargeContainerChildren = 1000

/// Children inspection walks, and whether rows were left out. A large row container lists only
/// its reported visible items and its non-item children, so off-screen rows do not spend the
/// visited budget before the rest of the window; callers report the result as truncated. The
/// inspect root itself is never pruned, so inspecting the container lists its rows. Inspection
/// is not a safety boundary, so the report is used without the audit's boundary check; an
/// unavailable or empty report keeps every child.
public func computerInspectChildren<Handle>(
  role: String, children: [Handle], isRoot: Bool,
  rowItems: () -> ComputerSecureAuditRowItems<Handle>?
) -> (children: [Handle], omitted: Bool) {
  guard !isRoot, computerSecureAuditRowContainerRoles.contains(role),
    children.count >= computerInspectLargeContainerChildren,
    let items = rowItems(), !items.visible.isEmpty
  else { return (children, false) }
  let kept = items.others + items.visible
  return (kept, kept.count < children.count)
}

/// Iterative depth-first traversal. Visited and emitted budgets are independent: pruning a
/// wrapper still visits its descendants. `stop` can throw a request cancellation/deadline or
/// return true for a soft time cutoff. True means there were nodes left when a cap stopped us.
public func computerInspectWalk<Handle>(
  root: Handle, maxNodes: Int, maxVisited: Int = computerInspectMaxVisited, stop: () throws -> Bool,
  visit: (Handle) throws -> (children: [Handle], emitted: Bool)
) rethrows -> Bool {
  let limit = min(800, max(1, maxNodes))
  var pending = [root]
  var visited = 0
  var emitted = 0
  while !pending.isEmpty {
    if try stop() { return true }
    if emitted >= limit || visited >= maxVisited { return true }
    visited += 1
    let node = try visit(pending.removeLast())
    if node.emitted { emitted += 1 }
    pending.append(contentsOf: node.children.reversed())
  }
  return false
}
