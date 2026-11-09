import Foundation

/// Confirm synchronously into the caller's ordered output queue, never via telemetry.
public func computerConfirmAction(
  requestId: String, executionGeneration: Int, emit: ([String: Any]) -> Void
) {
  emit([
    "type": "actionConfirmed", "requestId": requestId,
    "executionGeneration": executionGeneration,
  ])
}

/// Preserve background's pre-dispatch interruption facts and activation recovery errors.
public func computerActionFailure(
  _ payload: [String: Any], tracked: Bool, background: Bool, posted: Bool
) -> [String: Any] {
  guard tracked else { return payload }
  if posted && (!background || payload["_tag"] as? String == "Interrupted") {
    return ["_tag": "OutcomeUnknown"]
  }
  if payload["_tag"] as? String == "Interrupted" {
    return payload.merging(["actionStarted": false]) { _, new in new }
  }
  return payload
}

/// The error as the agent sees it: log-only fields never leave the helper inside it, on the
/// tracked and the untracked path alike (`computerActionFailure` passes untracked payloads on).
public func computerAgentFacingError(_ error: [String: Any]) -> [String: Any] {
  error.filter { $0.key != "axError" }
}

/// Log-only facts for an `OutcomeUnknown` response, sent beside (never inside) the error so
/// the agent-facing result is unchanged. Main logs them; they name no screen content.
public func computerOutcomeUnknownDiagnostic(
  error: [String: Any], failure: [String: Any], op: String, appId: String, background: Bool
) -> [String: Any]? {
  guard error["_tag"] as? String == "OutcomeUnknown" else { return nil }
  var diagnostic: [String: Any] = ["op": op, "delivery": background ? "background" : "foreground"]
  if !appId.isEmpty { diagnostic["appId"] = appId }
  if let axError = failure["axError"] as? Int { diagnostic["axError"] = axError }
  return diagnostic
}
