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
