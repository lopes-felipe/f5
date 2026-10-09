import XCTest

@testable import F5ComputerCore

final class PermitTests: XCTestCase {
  func testStartsSuspendedAndExpiresLocally() {
    let permit = ExecutionPermit()
    XCTAssertFalse(permit.authorized(1, id: "a", now: 0))
    permit.renew(1, duration: 1, now: 10)
    XCTAssertFalse(permit.authorized(1, id: "a", now: 10))
    permit.resume(1, now: 10)
    XCTAssertTrue(permit.authorized(1, id: "a", now: 10.99))
    XCTAssertFalse(permit.authorized(1, id: "a", now: 11))
    permit.renew(1, duration: 1, now: 11)
    XCTAssertFalse(permit.authorized(1, id: "a", now: 11))
  }
  func testCancelAndGenerationCannotBeReplayed() {
    let permit = ExecutionPermit()
    permit.renew(3, duration: 1, now: 1)
    permit.resume(3, now: 1)
    permit.cancel("a")
    XCTAssertFalse(permit.authorized(3, id: "a", now: 1))
    permit.renew(2, duration: 1, now: 1)
    permit.resume(2, now: 1)
    XCTAssertFalse(permit.authorized(2, id: "b", now: 1))
    XCTAssertTrue(permit.authorized(3, id: "b", now: 1))
  }
  func testModelSpaceLimits() {
    let (w, h) = modelSize(width: 5120, height: 2880)
    XCTAssertLessThanOrEqual(w, 1456)
    XCTAssertLessThanOrEqual(w * h, 1_150_000)
  }
  func testRenewalAfterAStallDoesNotReviveInput() {
    let permit = ExecutionPermit()
    permit.renew(1, duration: 1, now: 10)
    permit.resume(1, now: 10)
    permit.renew(1, duration: 1, now: 12)
    XCTAssertFalse(permit.authorized(1, id: "a", now: 12))
    permit.resume(1, now: 12)
    XCTAssertTrue(permit.authorized(1, id: "a", now: 12))
  }
}

final class ZoomGeometryTests: XCTestCase {
  func testZoomUsesCapturePixelsAndExclusiveModelBounds() {
    let crop = zoomPixelBounds(
      x: 100, y: 50, width: 100, height: 50, modelWidth: 1000, modelHeight: 500, captureWidth: 2000,
      captureHeight: 1000)!
    XCTAssertEqual(crop.x, 200)
    XCTAssertEqual(crop.y, 100)
    XCTAssertEqual(crop.width, 200)
    XCTAssertEqual(crop.height, 100)
    XCTAssertNil(
      zoomPixelBounds(
        x: 1000, y: 0, width: 1, height: 1, modelWidth: 1000, modelHeight: 500, captureWidth: 2000,
        captureHeight: 1000))
    XCTAssertNil(
      zoomPixelBounds(
        x: -1, y: 0, width: 1, height: 1, modelWidth: 1000, modelHeight: 500, captureWidth: 2000,
        captureHeight: 1000))
  }
}
