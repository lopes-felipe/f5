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
/// Foreground presses often remove their own element (a swatch closing its popover), which
/// AX reports as an error even though the press worked. That is dispatched-but-unverified,
/// like a background AXPress, never a stale element the agent would retry.
public func computerElementDispatchOutcome(
  action: String, error: AXError, background: Bool
) -> ComputerElementDispatchOutcome {
  if error == .success { return .success }
  if error == .actionUnsupported || error == .attributeUnsupported {
    return .failed(tag: "UnsupportedAction", reason: nil, started: false)
  }
  if (action == "setValue" || action == "focus") && computerAXWriteRejected(error) {
    return .failed(tag: "StaleElement", reason: "element-gone", started: false)
  }
  if background {
    return error == .cannotComplete
      ? .failed(tag: "OutcomeUnknown", reason: nil, started: true)
      : .failed(tag: "StaleElement", reason: "element-gone", started: true)
  }
  return .unverified
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
