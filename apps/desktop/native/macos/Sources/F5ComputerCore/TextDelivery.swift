import Foundation

/// Why foreground typing stopped after delivering some text. Raw values are the contract's
/// `verification.stoppedBy` literals.
public enum ComputerTypingStop: String, Equatable {
  case focusMoved = "focus-moved"
  case focusUnknown = "focus-unknown"
  case otherApp = "other-app"
  case ownerUnknown = "owner-unknown"
  case secureField = "secure-field"
  case notGranted = "not-granted"
}

/// The stop reason for a failure raised while re-reading focus between chunks, so a revoked
/// grant or a password field taking focus stays distinguishable from a harmless focus move.
public func computerTypingStop(failure: [String: Any]) -> ComputerTypingStop {
  switch failure["_tag"] as? String {
  case "NotGranted": return .notGranted
  case "TargetBlocked":
    return (failure["kind"] as? String).flatMap(ComputerTypingStop.init(rawValue:))
      ?? .focusUnknown
  default: return .focusUnknown
  }
}

/// Roles whose focus means keyboard input really goes there.
public func computerEditableRole(_ role: String?) -> Bool {
  guard let role else { return true }
  return ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role)
}

/// Whether typing may continue into the element it started in. AX focus can move to a
/// combobox's active option while keyboard input stays in the field (Chrome follows
/// `aria-activedescendant`). That counts as unchanged when the field still reports `AXFocused`,
/// or when the new, non-editable focus lies inside the field or inside an element the field
/// controls (`AXLinkedUIElements`). The expensive reads run only when needed.
public func computerTypingFocusUnchanged(
  samePidAndWindow: Bool, sameElement: Bool,
  initialStillFocused: @autoclosure () -> Bool,
  currentEditable: @autoclosure () -> Bool,
  currentWithinInitial: @autoclosure () -> Bool
) -> Bool {
  guard samePidAndWindow else { return false }
  if sameElement || initialStillFocused() { return true }
  return !currentEditable() && currentWithinInitial()
}

public enum ComputerTypingOutcome: Equatable {
  /// Every chunk was sent.
  case complete
  /// Focus moved before anything was sent: nothing happened yet.
  case blocked
  /// Focus moved after some text was sent; the rest was not. Counts are UTF-16 code units.
  case stopped(delivered: Int, requested: Int, reason: ComputerTypingStop)

  public var verification: [String: Any]? {
    guard case .stopped(let delivered, let requested, let reason) = self else { return nil }
    return [
      "verified": false, "charactersDelivered": delivered, "charactersRequested": requested,
      "stoppedBy": reason.rawValue,
    ]
  }
}

/// Foreground typing, one keydown/keyup pair per chunk of `chunkCharacters` characters.
/// The permit and focus are checked before each keydown only, never between keydown and keyup:
/// the keydown inserts its whole chunk and that insert may move focus as its own effect.
/// A posted keydown always gets its keyup. Errors from `checkPermit`, `focusBeforeStart`,
/// `postDown` and `pause` propagate unchanged; the caller maps them by whether input was posted.
public func computerDeliverText(
  _ text: String, chunkCharacters: Int = 32,
  checkPermit: () throws -> Void,
  focusBeforeStart: () throws -> Void,
  focusState: () -> ComputerTypingStop?,
  postDown: ([UniChar]) throws -> Void,
  postUp: ([UniChar]) -> Void,
  pause: () async throws -> Void
) async throws -> ComputerTypingOutcome {
  let characters = Array(text)
  let requested = text.utf16.count
  var start = 0
  var delivered = 0
  while start < characters.count {
    if start > 0 { try await pause() }
    try checkPermit()
    // Before any chunk, nothing happened yet: the original failure stays exact.
    if start == 0 { try focusBeforeStart() }
    let stop = focusState()
    switch computerDeliveryStep(delivered: delivered, focusUnchanged: stop == nil) {
    case .send: break
    case .blocked: return .blocked
    case .stop:
      return .stopped(delivered: delivered, requested: requested, reason: stop ?? .focusMoved)
    }
    let end = min(start + max(1, chunkCharacters), characters.count)
    let units = Array(String(characters[start..<end]).utf16)
    try postDown(units)
    postUp(units)
    delivered += units.count
    start = end
  }
  return .complete
}
