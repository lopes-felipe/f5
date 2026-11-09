/// Bounded, content-free diagnostics for one captured window's password audit.
/// Never records element handles, labels, values, URLs, or frames.
public final class ComputerSecureAuditDiagnostics {
  public enum StopReason: String, CaseIterable {
    case deadline
    case nodeBudget = "node-budget"
    case depthLimit = "depth-limit"
    case unreadableNode = "unreadable-node"
    case unreadableChildren = "unreadable-children"
    /// An element's subrole read failed. Masks only when the role can be a secure field.
    case unreadableSubrole = "unreadable-subrole"
    case secureFieldWithoutFrame = "secure-field-without-frame"
    case searchLimit = "search-limit"
    case searchIncomplete = "search-incomplete"
    case windowMatch = "window-match"
  }
  public enum Operation: String, CaseIterable {
    case nodeRead = "node-read"
    case role, subrole, children
    case textFields = "text-fields"
    case frames
  }
  public struct AXFailure: Equatable {
    public let operation: Operation
    public let error: Int
    public var count: Int
  }
  public private(set) var visitedNodes = 0
  private var nodeReadSeconds = 0.0
  public var nodeReadElapsedMs: Int { Int((nodeReadSeconds * 1000).rounded()) }
  public private(set) var maxChildren = 0
  public private(set) var textFieldQueries = 0
  public private(set) var frameQueries = 0
  public private(set) var searchResults = 0
  private var searchSeconds = 0.0
  public var searchElapsedMs: Int { Int((searchSeconds * 1000).rounded()) }
  public private(set) var searchFallbacks = 0
  public private(set) var invalidSearchResults = 0
  public private(set) var lastSearchFailure: StopReason?
  public private(set) var stopReasons: Set<StopReason> = []
  public private(set) var axFailures: [AXFailure] = []

  public init() {}
  public func visitNode() { visitedNodes += 1 }
  public func nodeReadDuration(seconds: Double) { nodeReadSeconds += max(0, seconds) }
  public func observedChildren(_ count: Int) { maxChildren = max(maxChildren, count) }
  public func stop(_ reason: StopReason) { stopReasons.insert(reason) }
  public func searchQuery(_ key: String) {
    if key == "AXTextFieldSearchKey" { textFieldQueries += 1 }
    if key == "AXFrameSearchKey" { frameQueries += 1 }
  }
  public func foundSearchResults(_ count: Int) { searchResults += count }
  public func searchDuration(seconds: Double) { searchSeconds += max(0, seconds) }
  public func searchFallback() { searchFallbacks += 1 }
  public func beginSearch() { lastSearchFailure = nil }
  public func failSearch(_ reason: StopReason) {
    lastSearchFailure = reason
    stop(reason)
  }
  public func invalidSearchResult() { invalidSearchResults += 1 }
  public func axFailure(_ operation: Operation, error: Int) {
    if let index = axFailures.firstIndex(where: { $0.operation == operation && $0.error == error })
    {
      axFailures[index].count += 1
    } else if axFailures.count < 32 {
      axFailures.append(AXFailure(operation: operation, error: error, count: 1))
    }
  }
}
