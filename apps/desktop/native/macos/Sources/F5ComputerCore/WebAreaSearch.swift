/// Fast masking accepts that accessibility search can omit visible password fields.
/// Missing/unknown request values retain the conservative walk used by legacy servers.
public enum ComputerPasswordMasking: String {
  case fast
  case conservative

  public static func requested(_ value: String?) -> Self {
    Self(rawValue: value ?? "") ?? .conservative
  }

  public var usesWebAreaSearch: Bool { self == .fast }
}

/// Searches text fields in a web area and every nested frame without walking DOM children.
/// nil means the root search is unavailable, so the caller should walk normally. A limit-sized
/// result means incomplete (also used for a failed nested search or an expired deadline).
public func computerSearchWebArea<Handle: Hashable>(
  root: Handle, expired: () -> Bool,
  diagnostics: ComputerSecureAuditDiagnostics? = nil,
  query: (Handle, String) -> [Handle]?
) -> [Handle]? {
  diagnostics?.beginSearch()
  let limit = 5000
  var queue = [root]
  var seen: Set<Handle> = [root]
  var results: [Handle] = []
  var head = 0
  func incomplete(_ reason: ComputerSecureAuditDiagnostics.StopReason) -> [Handle] {
    diagnostics?.failSearch(reason)
    return Array(repeating: root, count: limit)
  }
  func search(_ frame: Handle, _ key: String) -> [Handle]? {
    diagnostics?.searchQuery(key)
    let found = query(frame, key)
    if let found { diagnostics?.foundSearchResults(found.count) }
    return found
  }
  while head < queue.count {
    if expired() { return incomplete(.deadline) }
    let frame = queue[head]
    head += 1
    guard let text = search(frame, "AXTextFieldSearchKey"),
      !expired(), let frames = search(frame, "AXFrameSearchKey")
    else {
      if expired() { return incomplete(.deadline) }
      if head == 1 {
        diagnostics?.searchFallback()
        return nil
      }
      return incomplete(.searchIncomplete)
    }
    if text.count >= limit || frames.count >= limit { return incomplete(.searchLimit) }
    results.append(contentsOf: text)
    if results.count >= limit { return incomplete(.searchLimit) }
    for child in frames where seen.insert(child).inserted {
      queue.append(child)
      // Include frame results so the audit budgets and checks their readability too.
      results.append(child)
    }
    if results.count >= limit { return incomplete(.searchLimit) }
  }
  return results
}
