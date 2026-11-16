import CoreGraphics
import ScreenCaptureKit
import XCTest
@testable import F5ComputerCore

final class CaptureConfigurationTests: XCTestCase {
  func testBackgroundColorSurvivesSuspensionAndNativeConfigurationCopy() async throws {
    let result = try await withComputerCaptureConfiguration(
      width: 1456, height: 609, displaySize: CGSize(width: 3337, height: 1397)
    ) { config in
      await Task.yield()
      // SCScreenshotManager copies this native configuration; copying retains
      // backgroundColor, which otherwise points at an already released CGColor.
      let copy = try XCTUnwrap(config.copy() as? SCStreamConfiguration)
      XCTAssertEqual(copy.width, 1456)
      XCTAssertEqual(copy.height, 609)
      // The whole display maps onto the whole output, whatever the filter covers.
      XCTAssertEqual(copy.sourceRect, CGRect(x: 0, y: 0, width: 3337, height: 1397))
      XCTAssertEqual(copy.destinationRect, CGRect(x: 0, y: 0, width: 1456, height: 609))
      XCTAssertTrue(copy.ignoreShadowsDisplay)
      XCTAssertFalse(copy.showsCursor)
      XCTAssertEqual(copy.backgroundColor.alpha, 0)
      return 42
    }
    XCTAssertEqual(result, 42)
  }
  func testFailedCapturePropagatesAfterSuspension() async {
    enum CaptureError: Error { case failed }
    do {
      _ = try await withComputerCaptureConfiguration(
        width: 100, height: 100, displaySize: CGSize(width: 100, height: 100)
      ) { config in
        await Task.yield()
        _ = config.copy()
        throw CaptureError.failed
      }
      XCTFail("Capture error was swallowed")
    } catch CaptureError.failed {} catch { XCTFail("Unexpected error") }
  }
}
