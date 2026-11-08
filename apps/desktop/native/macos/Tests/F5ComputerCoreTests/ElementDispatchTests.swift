import ApplicationServices
import XCTest
@testable import F5ComputerCore

final class ElementDispatchTests: XCTestCase {
  func testForegroundPressThatRemovesItsElementIsUnverified() {
    for error in [AXError.invalidUIElement, .cannotComplete, .failure] {
      XCTAssertEqual(
        computerElementDispatchOutcome(action: "press", error: error, background: false),
        .unverified)
    }
  }
  func testSuccessIsSuccess() {
    XCTAssertEqual(
      computerElementDispatchOutcome(action: "press", error: .success, background: false),
      .success)
  }
  func testUnsupportedActionsProveNoEffect() {
    for background in [false, true] {
      XCTAssertEqual(
        computerElementDispatchOutcome(
          action: "press", error: .actionUnsupported, background: background),
        .failed(tag: "UnsupportedAction", reason: nil, started: false))
    }
  }
  func testRejectedWritesProveNoEffect() {
    for action in ["setValue", "focus"] {
      XCTAssertEqual(
        computerElementDispatchOutcome(action: action, error: .illegalArgument, background: false),
        .failed(tag: "StaleElement", reason: "element-gone", started: false))
    }
    XCTAssertEqual(
      computerElementDispatchOutcome(action: "setValue", error: .cannotComplete, background: false),
      .unverified)
  }
  func testBackgroundKeepsItsEscalation() {
    XCTAssertEqual(
      computerElementDispatchOutcome(action: "press", error: .cannotComplete, background: true),
      .failed(tag: "OutcomeUnknown", reason: nil, started: true))
    XCTAssertEqual(
      computerElementDispatchOutcome(action: "press", error: .invalidUIElement, background: true),
      .failed(tag: "StaleElement", reason: "element-gone", started: true))
  }
  func testChordSteps() {
    XCTAssertEqual(computerChordStep(chordsDelivered: 0, focusUnchanged: true), .send)
    XCTAssertEqual(computerChordStep(chordsDelivered: 0, focusUnchanged: false), .blocked)
    XCTAssertEqual(computerChordStep(chordsDelivered: 1, focusUnchanged: false), .stop)
    XCTAssertEqual(computerChordStep(chordsDelivered: 3, focusUnchanged: true), .send)
  }
}
