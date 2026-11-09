import ApplicationServices

/// AX errors returned before the target accepted the write; anything else is ambiguous.
public func computerAXWriteRejected(_ error: AXError) -> Bool {
  [.attributeUnsupported, .illegalArgument, .notImplemented, .apiDisabled, .invalidUIElement]
    .contains(error)
}

public enum ComputerElementDispatchOutcome: Equatable {
  case success
  /// The dispatch went out but its effect cannot be read back: report success, unverified.
  case unverified
  /// `started == false` proves nothing happened, so the failure must not escalate to
  /// OutcomeUnknown after the helper marked the request as posted.
  case failed(tag: String, reason: String?, started: Bool)
}

/// Classifies an AX element action's result after dispatch.
///
/// A foreground press that removes its own element (a swatch closing its popover) gets
/// `invalidUIElement` although it worked: that is dispatched-but-unverified, like a background
/// AXPress, never a stale element the agent would retry. A messaging timeout
/// (`cannotComplete`) may still apply later, so it stays an unknown outcome: retrying it could
/// repeat an irreversible action.
public func computerElementDispatchOutcome(
  action: String, error: AXError, background: Bool
) -> ComputerElementDispatchOutcome {
  if error == .success { return .success }
  if error == .actionUnsupported || error == .attributeUnsupported {
    return .failed(tag: "UnsupportedAction", reason: nil, started: false)
  }
  let write = action == "setValue" || action == "focus"
  if computerAXWriteRejected(error) && (write || error != .invalidUIElement) {
    // The call was refused before reaching the element (for example AX was disabled).
    return .failed(tag: "StaleElement", reason: "element-gone", started: false)
  }
  if background {
    return error == .cannotComplete
      ? .failed(tag: "OutcomeUnknown", reason: nil, started: true)
      : .failed(tag: "StaleElement", reason: "element-gone", started: true)
  }
  if error == .invalidUIElement { return .unverified }
  return .failed(tag: "OutcomeUnknown", reason: nil, started: true)
}

/// Classifies a foreground action whose dispatch hit the messaging timeout (`cannotComplete`),
/// given one bounded probe of the element afterwards.
///
/// A press that removed its own element (a swatch closing its popover) was received, so it is
/// dispatched-but-unverified, as when the press itself returns `invalidUIElement`. A write
/// (`setValue`, `focus`) or an element that is still there stays an unknown outcome: the
/// action may still apply, and retrying could repeat it.
public func computerElementTimeoutOutcome(
  action: String, elementGone: Bool
) -> ComputerElementDispatchOutcome {
  let write = action == "setValue" || action == "focus"
  return elementGone && !write
    ? .unverified : .failed(tag: "OutcomeUnknown", reason: nil, started: true)
}

public enum ComputerChordStep: Equatable {
  case send
  /// Focus moved before any chord was delivered: nothing happened yet.
  case blocked
  /// Focus moved after delivered chords (often their own effect): stop, report unverified.
  case stop
}

/// Focus is checked before each chord's keydown only; a keyup always follows its keydown.
public func computerChordStep(chordsDelivered: Int, focusUnchanged: Bool) -> ComputerChordStep {
  focusUnchanged ? .send : chordsDelivered == 0 ? .blocked : .stop
}
