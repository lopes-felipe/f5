import CoreGraphics
import XCTest

@testable import F5ComputerCore

final class CaptureLayoutTests: XCTestCase {
  func testActionDisplayFollowsRequestOrFocusedWindowWithoutArbitraryFallback() {
    let displays = [
      (id: "left", bounds: CGRect(x: 0, y: 0, width: 1000, height: 800)),
      (id: "right", bounds: CGRect(x: 1000, y: 0, width: 1000, height: 800)),
    ]
    let window = CGRect(x: 1200, y: 50, width: 600, height: 500)
    XCTAssertEqual(
      computerActionDisplayID(requestedID: nil, windowFrame: window, displays: displays), "right")
    XCTAssertEqual(
      computerActionDisplayID(requestedID: "left", windowFrame: window, displays: displays), "left")
    XCTAssertNil(
      computerActionDisplayID(requestedID: "unknown", windowFrame: window, displays: displays))
    XCTAssertNil(computerActionDisplayID(requestedID: nil, windowFrame: nil, displays: displays))
    XCTAssertNil(computerActionDisplayID(requestedID: nil, windowFrame: .zero, displays: displays))
  }
  private let window = CGRect(x: 185, y: 43, width: 256, height: 213)
  private func neutralCanvas() -> CGContext {
    let canvas = CGContext(
      data: nil, width: 1456, height: 609, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    canvas.setFillColor(CGColor(gray: 0.45, alpha: 1))
    canvas.fill(CGRect(x: 0, y: 0, width: 1456, height: 609))
    return canvas
  }
  /// Fills `rect` given in top-left canvas coordinates.
  private func fill(_ canvas: CGContext, _ rect: CGRect, gray: Double) {
    canvas.setFillColor(CGColor(gray: gray, alpha: 1))
    canvas.fill(
      CGRect(
        x: rect.minX, y: Double(canvas.height) - rect.maxY, width: rect.width, height: rect.height))
  }
  func testCanvasRectMapsPrimaryAndOffsetDisplays() {
    let primary = CGRect(x: 0, y: 0, width: 3337, height: 1397)
    let mapped = computerCanvasRect(
      CGRect(x: 424, y: 98, width: 586, height: 488), display: primary, canvasWidth: 1456,
      canvasHeight: 609)
    XCTAssertEqual(mapped.minX, 424 * 1456 / 3337, accuracy: 0.001)
    XCTAssertEqual(mapped.minY, 98 * 609 / 1397, accuracy: 0.001)
    XCTAssertEqual(mapped.width, 586 * 1456 / 3337, accuracy: 0.001)
    XCTAssertEqual(mapped.height, 488 * 609 / 1397, accuracy: 0.001)
    let offset = computerCanvasRect(
      CGRect(x: 1424, y: 98, width: 586, height: 488),
      display: CGRect(x: 1000, y: 0, width: 3337, height: 1397), canvasWidth: 1456,
      canvasHeight: 609)
    XCTAssertEqual(offset.minX, mapped.minX, accuracy: 0.001)
    XCTAssertEqual(offset.minY, mapped.minY, accuracy: 0.001)
  }
  func testNeutralCanvasAndContentInsideAllowedRectsPass() {
    let canvas = neutralCanvas()
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: []))
    fill(canvas, window, gray: 0.12)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testAntialiasedEdgesWithinTheMarginPass() {
    let canvas = neutralCanvas()
    fill(canvas, window.insetBy(dx: -2, dy: -2), gray: 0.12)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testSlightColorDriftOutsideAllowedRectsPasses() {
    let canvas = neutralCanvas()
    fill(canvas, CGRect(x: 0, y: 0, width: 1456, height: 609), gray: 0.45 + 8.0 / 255)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testWindowDrawnAtTheTopLeftInsteadOfItsFrameFails() {
    // The observed regression: the window filled 732x609 from the origin.
    let canvas = neutralCanvas()
    fill(canvas, CGRect(x: 0, y: 0, width: 732, height: 609), gray: 0.12)
    XCTAssertTrue(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testAFewStrayPixelsDoNotFail() {
    let canvas = neutralCanvas()
    fill(canvas, CGRect(x: 1000, y: 400, width: 8, height: 8), gray: 0.9)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testSixtyFourOutsideSamplesPassAndSixtyFiveFail() {
    // Samples sit on even coordinates: a 16x16 block at an even origin holds 8x8 of them.
    let canvas = neutralCanvas()
    fill(canvas, CGRect(x: 1000, y: 400, width: 16, height: 16), gray: 0.9)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
    fill(canvas, CGRect(x: 1100, y: 400, width: 2, height: 2), gray: 0.9)
    XCTAssertTrue(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testSeveralAllowedRectsOnOneRow() {
    let left = CGRect(x: 100, y: 100, width: 200, height: 100)
    let right = CGRect(x: 600, y: 100, width: 200, height: 100)
    let canvas = neutralCanvas()
    fill(canvas, left, gray: 0.12)
    fill(canvas, right, gray: 0.12)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [left, right]))
    fill(canvas, CGRect(x: 350, y: 100, width: 200, height: 100), gray: 0.12)
    XCTAssertTrue(computerCaptureContentOutside(canvas, allowed: [left, right]))
  }
  func testAllowedRectPartlyOffTheCanvas() {
    let edge = CGRect(x: 1400, y: -20, width: 200, height: 120)
    let canvas = neutralCanvas()
    fill(canvas, CGRect(x: 1400, y: 0, width: 56, height: 100), gray: 0.12)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [edge]))
  }
  func testZoomCanvasWithMorePixelsThanPoints() {
    // Zoom captures at pixel scale: 2 canvas px of margin is 1 pt.
    let display = CGRect(x: 0, y: 0, width: 1000, height: 500)
    let canvas = CGContext(
      data: nil, width: 2000, height: 1000, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    canvas.setFillColor(CGColor(gray: 0.45, alpha: 1))
    canvas.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000))
    let frame = computerCanvasRect(
      CGRect(x: 100, y: 100, width: 200, height: 100), display: display, canvasWidth: 2000,
      canvasHeight: 1000)
    XCTAssertEqual(frame, CGRect(x: 200, y: 200, width: 400, height: 200))
    fill(canvas, frame, gray: 0.12)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [frame]))
    XCTAssertTrue(computerCaptureContentOutside(canvas, allowed: [frame.offsetBy(dx: 20, dy: 0)]))
  }
  func testMenuBarBandIsAStripAtTheTopOfTheDisplay() {
    let primary = CGRect(x: 0, y: 0, width: 3337, height: 1397)
    XCTAssertEqual(
      computerMenuBarBand(
        display: primary, menuWindows: [CGRect(x: 0, y: 0, width: 3337, height: 37)]),
      CGRect(x: 0, y: 0, width: 3337, height: 37))
    // A full-height window at menu level cannot widen the allowance past 64 pt.
    XCTAssertEqual(computerMenuBarBand(display: primary, menuWindows: [primary]).height, 64)
    XCTAssertEqual(computerMenuBarBand(display: primary, menuWindows: []).height, 44)
    let secondary = CGRect(x: 1000, y: 1397, width: 1728, height: 1117)
    XCTAssertEqual(
      computerMenuBarBand(
        display: secondary,
        menuWindows: [
          CGRect(x: 0, y: 0, width: 3337, height: 37),
          CGRect(x: 1000, y: 1397, width: 1728, height: 24),
        ]),
      CGRect(x: 1000, y: 1397, width: 1728, height: 24))
  }
  func testMaskDrawRectAndLayoutCheckAgreeOnCoordinates() {
    XCTAssertEqual(
      computerCanvasDrawRect(CGRect(x: 10, y: 20, width: 30, height: 40), canvasHeight: 100),
      CGRect(x: 10, y: 40, width: 30, height: 40))
    // Content filled through the draw rect lands where the check expects it.
    let canvas = neutralCanvas()
    canvas.setFillColor(CGColor(gray: 0.12, alpha: 1))
    canvas.fill(computerCanvasDrawRect(window, canvasHeight: canvas.height))
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
    XCTAssertTrue(
      computerCaptureContentOutside(canvas, allowed: [window.offsetBy(dx: 0, dy: 200)]))
  }
}
