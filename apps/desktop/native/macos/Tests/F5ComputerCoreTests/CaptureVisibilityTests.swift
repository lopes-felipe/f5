import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class CaptureVisibilityTests: XCTestCase {
  func testWindowsOnOtherDisplayOrTouchingEdgeDoNotRequireCapture() {
    let display = CGRect(x: 0, y: 0, width: 3337, height: 1397)
    XCTAssertFalse(computerCaptureWindowIntersectsDisplay(
      window: CGRect(x: 902, y: 1397, width: 500, height: 300), display: display))
    XCTAssertFalse(computerCaptureWindowIntersectsDisplay(
      window: CGRect(x: 3337, y: 100, width: 500, height: 300), display: display))
    XCTAssertFalse(computerCaptureWindowIntersectsDisplay(window: .zero, display: display))
  }
  func testPartiallyVisibleWindowAndNegativeDisplayOriginsRemainCapturable() {
    let display = CGRect(x: -1728, y: 0, width: 1728, height: 1117)
    XCTAssertTrue(computerCaptureWindowIntersectsDisplay(
      window: CGRect(x: -10, y: 50, width: 500, height: 300), display: display))
    XCTAssertTrue(computerCaptureWindowIntersectsDisplay(
      window: CGRect(x: -1728, y: 50, width: 500, height: 300), display: display))
    XCTAssertFalse(computerCaptureWindowIntersectsDisplay(
      window: CGRect(x: 0, y: 50, width: 500, height: 300), display: display))
  }
}
