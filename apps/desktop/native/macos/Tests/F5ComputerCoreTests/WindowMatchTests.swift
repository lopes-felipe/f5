import CoreGraphics
import XCTest

@testable import F5ComputerCore

final class WindowMatchTests: XCTestCase {
  let frame = CGRect(x: 0, y: 0, width: 100, height: 100)
  func match(_ ids: [CGWindowID?], minimized: Set<Int> = []) -> Int? {
    computerMatchAXWindow(
      windows: Array(ids.indices), windowID: 42, frame: frame,
      id: { ids[$0] }, rect: { _ in self.frame }, minimized: { minimized.contains($0) })
  }
  func testIDWinsOverIdenticalFrames() {
    XCTAssertEqual(match([nil, 12, 42]), 2)
    XCTAssertNil(match([12]))
  }
  func testMinimizedDuplicateIsIgnored() {
    XCTAssertEqual(match([42, 42], minimized: [1]), 0)
    XCTAssertEqual(match([nil, nil], minimized: [1]), 0)
  }
  func testAmbiguousAndMissingMatchesFailClosed() {
    XCTAssertNil(match([42, 42]))
    XCTAssertNil(match([nil, nil]))
    XCTAssertNil(match([]))
    XCTAssertEqual(match([nil]), 0)
  }
}
