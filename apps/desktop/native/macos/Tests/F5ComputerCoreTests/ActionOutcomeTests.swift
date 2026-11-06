import XCTest
@testable import F5ComputerCore

final class ActionOutcomeTests: XCTestCase {
  func testConfirmationPrecedesResponseWhileTelemetryIsBlocked() {
    let telemetry = DispatchQueue(label: "blocked-telemetry")
    let entered = DispatchSemaphore(value: 0)
    let unblock = DispatchSemaphore(value: 0)
    telemetry.async { entered.signal(); unblock.wait() }
    entered.wait()
    defer { unblock.signal(); telemetry.sync {} }
    var output: [String] = []
    computerConfirmAction(requestId: "action", executionGeneration: 7) {
      output.append($0["type"] as! String)
    }
    output.append("response")
    XCTAssertEqual(output, ["actionConfirmed", "response"])
  }
  func testForegroundAndBackgroundFailureClassification() {
    for background in [false, true] {
      XCTAssertEqual(computerActionFailure(
        ["_tag": "Interrupted"], tracked: true, background: background, posted: false
      )["actionStarted"] as? Bool, false)
      XCTAssertEqual(computerActionFailure(
        ["_tag": "Interrupted"], tracked: true, background: background, posted: true
      )["_tag"] as? String, "OutcomeUnknown")
    }
    XCTAssertEqual(computerActionFailure(
      ["_tag": "StaleElement"], tracked: true, background: false, posted: true
    )["_tag"] as? String, "OutcomeUnknown")
    XCTAssertEqual(computerActionFailure(
      ["_tag": "ForegroundRequired"], tracked: true, background: true, posted: true
    )["_tag"] as? String, "ForegroundRequired")
  }
}
