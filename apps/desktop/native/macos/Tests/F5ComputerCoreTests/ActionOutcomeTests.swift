import XCTest
@testable import F5ComputerCore

final class ActionOutcomeTests: XCTestCase {
  func testConfirmationCallbackRunsSynchronouslyBeforeResponse() {
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
  func testOutcomeUnknownDiagnosticIsLogOnly() {
    let failure: [String: Any] = ["_tag": "OutcomeUnknown", "axError": -25204]
    let error = computerActionFailure(failure, tracked: true, background: false, posted: true)
    XCTAssertEqual(error.keys.sorted(), ["_tag"])
    let diagnostic = computerOutcomeUnknownDiagnostic(
      error: error, failure: failure, op: "elementAction", appId: "com.apple.Preview",
      background: false)
    XCTAssertEqual(diagnostic?["op"] as? String, "elementAction")
    XCTAssertEqual(diagnostic?["appId"] as? String, "com.apple.Preview")
    XCTAssertEqual(diagnostic?["axError"] as? Int, -25204)
    XCTAssertEqual(diagnostic?["delivery"] as? String, "foreground")
    XCTAssertNil(computerOutcomeUnknownDiagnostic(
      error: ["_tag": "StaleElement"], failure: failure, op: "elementAction", appId: "",
      background: true))
    let bare = computerOutcomeUnknownDiagnostic(
      error: ["_tag": "OutcomeUnknown"], failure: ["_tag": "Interrupted"], op: "click", appId: "",
      background: true)
    XCTAssertNil(bare?["axError"])
    XCTAssertNil(bare?["appId"])
    XCTAssertEqual(bare?["delivery"] as? String, "background")
  }
}
