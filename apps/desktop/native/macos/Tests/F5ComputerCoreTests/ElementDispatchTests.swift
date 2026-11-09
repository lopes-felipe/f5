import ApplicationServices
import XCTest
@testable import F5ComputerCore

final class ElementDispatchTests: XCTestCase {
  func testForegroundPressThatRemovesItsElementIsUnverified() {
    for action in ["press", "increment", "showMenu"] {
      XCTAssertEqual(
        computerElementDispatchOutcome(action: action, error: .invalidUIElement, background: false),
        .unverified)
    }
  }
  func testForegroundTimeoutOrFailureStaysUnknown() {
    // A timed-out press may still apply; reporting success would invite a duplicate.
    for action in ["press", "setValue", "focus"] {
      for error in [AXError.cannotComplete, .failure] {
        XCTAssertEqual(
          computerElementDispatchOutcome(action: action, error: error, background: false),
          .failed(tag: "OutcomeUnknown", reason: nil, started: true))
      }
    }
  }
  func testForegroundTimeoutThatRemovedItsElementIsUnverified() {
    // A swatch whose press timed out while closing its popover was received.
    for action in ["press", "increment", "showMenu"] {
      XCTAssertEqual(computerElementTimeoutOutcome(action: action, elementGone: true), .unverified)
    }
  }
  func testForegroundTimeoutWithElementPresentOrWriteStaysUnknown() {
    for action in ["press", "setValue", "focus"] {
      XCTAssertEqual(
        computerElementTimeoutOutcome(action: action, elementGone: false),
        .failed(tag: "OutcomeUnknown", reason: nil, started: true))
    }
    for action in ["setValue", "focus"] {
      XCTAssertEqual(
        computerElementTimeoutOutcome(action: action, elementGone: true),
        .failed(tag: "OutcomeUnknown", reason: nil, started: true))
    }
  }
  func testRefusedPressProvesNoEffect() {
    for error in [AXError.apiDisabled, .notImplemented, .illegalArgument] {
      for background in [false, true] {
        XCTAssertEqual(
          computerElementDispatchOutcome(action: "press", error: error, background: background),
          .failed(tag: "StaleElement", reason: "element-gone", started: false))
      }
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
      XCTAssertEqual(
        computerElementDispatchOutcome(action: action, error: .invalidUIElement, background: false),
        .failed(tag: "StaleElement", reason: "element-gone", started: false))
    }
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
