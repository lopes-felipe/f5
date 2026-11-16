import XCTest
@testable import F5ComputerCore

final class PostActionSettleTests: XCTestCase {
  func testMetadataDependentSettle() {
    for op in ["type", "key", "elementAction", "openApp", "activateApp"] {
      for screenshot in [false, true] {
        for targeted in [false, true] {
          for displays in [0, 1, 2] {
            let expected = screenshot || !targeted || displays != 1
              || ["openApp", "activateApp"].contains(op) ? 300 : 0
            XCTAssertEqual(computerPostActionSettleMs(
              op: op, screenshot: screenshot, appTargeted: targeted, displayCount: displays),
              expected)
          }
        }
      }
    }
  }
  func testPollingStopsAtSuccessDeadlineAndCancellation() {
    var clock: TimeInterval = 0
    var reads = 0
    XCTAssertTrue(computerPollUntil(
      timeout: 0.5, now: { clock }, sleep: { clock += $0 }, cancelled: { false },
      predicate: { reads += 1; return clock >= 0.2 }))
    XCTAssertGreaterThanOrEqual(clock, 0.2)
    clock = 0
    XCTAssertFalse(computerPollUntil(
      timeout: 0.5, now: { clock }, sleep: { clock += $0 }, cancelled: { false },
      predicate: { false }))
    XCTAssertEqual(clock, 0.5, accuracy: 0.001)
    reads = 0
    XCTAssertFalse(computerPollUntil(timeout: 0.5, cancelled: { true },
      predicate: { reads += 1; return true }))
    XCTAssertEqual(reads, 0)
  }
}
