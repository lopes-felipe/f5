import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class CaptureCanvasTests: XCTestCase {
  private enum CaptureFailure: Error { case unavailable }
  func testEmptyAuthorizationNeverReadsPixelsAndReturnsNeutralCanvas() async throws {
    var calls = 0
    let canvas = try await authorizedComputerCaptureCanvas(width: 16, height: 16, applicationCount: 0) {
      calls += 1
      throw ComputerCaptureCanvasError.invalidGeometry
    }
    XCTAssertEqual(calls, 0)
    let pixels = canvas.data!.assumingMemoryBound(to: UInt8.self)
    for row in 0..<16 {
      for column in 0..<16 {
        let offset = row * canvas.bytesPerRow + column * 4
        XCTAssertEqual(pixels[offset], pixels[offset + 1])
        XCTAssertEqual(pixels[offset + 1], pixels[offset + 2])
        XCTAssertTrue((90...190).contains(Int(pixels[offset])))
        XCTAssertEqual(pixels[offset + 3], 255)
      }
    }
  }
  func testNonemptyAuthorizationUsesTheCaptureOnce() async throws {
    var calls = 0
    let source = CGContext(
      data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    source.setFillColor(CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [0, 1, 0, 1])!)
    source.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
    let canvas = try await authorizedComputerCaptureCanvas(width: 16, height: 16, applicationCount: 1) {
      calls += 1
      return source.makeImage()!
    }
    XCTAssertEqual(calls, 1)
    let pixels = canvas.data!.assumingMemoryBound(to: UInt8.self)
    XCTAssertGreaterThan(pixels[1], 240)
    XCTAssertLessThan(pixels[0], 20)
    XCTAssertLessThan(pixels[2], 20)
  }
  func testTransparentCaptureBackgroundLeavesTheNeutralFill() async throws {
    // The capture's background is transparent, so outside windows the canvas keeps its own
    // neutral fill and the layout check's reference matches exactly.
    let source = CGContext(
      data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    source.clear(CGRect(x: 0, y: 0, width: 64, height: 64))
    source.setFillColor(CGColor(gray: 0.12, alpha: 1))
    source.fill(CGRect(x: 0, y: 32, width: 32, height: 32))
    let canvas = try await authorizedComputerCaptureCanvas(width: 64, height: 64, applicationCount: 1) {
      source.makeImage()!
    }
    let pixels = canvas.data!.assumingMemoryBound(to: UInt8.self)
    let outside = 48 * canvas.bytesPerRow + 48 * 4
    XCTAssertEqual(
      [Int(pixels[outside]), Int(pixels[outside + 1]), Int(pixels[outside + 2])],
      computerNeutralCanvasPixel())
    // The opaque block sits at the top-left: allowed there it passes, unallowed it fails.
    XCTAssertFalse(
      computerCaptureContentOutside(canvas, allowed: [CGRect(x: 0, y: 0, width: 32, height: 32)]))
    XCTAssertTrue(computerCaptureContentOutside(canvas, allowed: []))
  }
  func testInvalidGeometryOrCountFailsBeforeCapture() async {
    var calls = 0
    for (width, height, count) in [(0, 16, 1), (16, 0, 1), (16, 16, -1)] {
      do {
        _ = try await authorizedComputerCaptureCanvas(width: width, height: height, applicationCount: count) {
          calls += 1
          throw ComputerCaptureCanvasError.invalidGeometry
        }
        XCTFail("Invalid capture accepted")
      } catch ComputerCaptureCanvasError.invalidGeometry {} catch { XCTFail("Unexpected failure") }
    }
    XCTAssertEqual(calls, 0)
  }
  func testAuthorizedCaptureFailureDoesNotReturnNeutralFallback() async {
    var calls = 0
    do {
      _ = try await authorizedComputerCaptureCanvas(width: 16, height: 16, applicationCount: 1) {
        calls += 1
        throw CaptureFailure.unavailable
      }
      XCTFail("Failed capture returned an image")
    } catch CaptureFailure.unavailable {} catch { XCTFail("Unexpected failure") }
    XCTAssertEqual(calls, 1)
  }
}
