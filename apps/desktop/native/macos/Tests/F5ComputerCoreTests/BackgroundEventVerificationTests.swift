import XCTest
@testable import F5ComputerCore

final class BackgroundEventVerificationTests: XCTestCase {
  func testShiftMustExtendACollapsedCaretExactlyOneCharacterLeft() {
    XCTAssertTrue(computerSelectionExtendedLeft(
      beforeStart: 4, beforeLength: 0, afterStart: 3, afterLength: 1))
    // An ignored modifier moves the caret, but selects nothing.
    XCTAssertFalse(computerSelectionExtendedLeft(
      beforeStart: 4, beforeLength: 0, afterStart: 3, afterLength: 0))
    // A pre-existing range collapsing or shrinking is not a valid rehearsal.
    XCTAssertFalse(computerSelectionExtendedLeft(
      beforeStart: 4, beforeLength: 2, afterStart: 4, afterLength: 0))
    XCTAssertFalse(computerSelectionExtendedLeft(
      beforeStart: 4, beforeLength: 2, afterStart: 4, afterLength: 1))
  }
}
