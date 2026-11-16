import XCTest

@testable import F5ComputerCore

final class WebAreaSearchTests: XCTestCase {
  func testNestedFramesAreSearchedOnceIncludingCycles() {
    var calls: [Int] = []
    let fields = computerSearchWebArea(root: 0, expired: { false }) { frame, key in
      if key == "AXTextFieldSearchKey" {
        calls.append(frame)
        return [frame + 10]
      }
      return frame == 0 ? [1, 1] : [0, 2].filter { $0 != frame }
    }
    XCTAssertEqual(calls, [0, 1, 2])
    XCTAssertEqual(fields, [10, 1, 11, 2, 12])
  }
  func testUnsupportedRootFallsBackButIncompleteNestedSearchFailsClosed() {
    XCTAssertNil(computerSearchWebArea(root: 0, expired: { false }, query: { _, _ in nil }))
    let nested = computerSearchWebArea(root: 0, expired: { false }) { frame, key in
      if frame == 1 { return nil }
      return key == "AXFrameSearchKey" ? [1] : []
    }
    XCTAssertEqual(nested?.count, 5000)
  }
  func testEachSearchLimitAndDeadlineFailClosed() {
    for key in ["AXTextFieldSearchKey", "AXFrameSearchKey"] {
      let result = computerSearchWebArea(root: 0, expired: { false }) { _, query in
        query == key ? Array(repeating: 1, count: 5000) : []
      }
      XCTAssertEqual(result?.count, 5000)
    }
    XCTAssertEqual(
      computerSearchWebArea(
        root: 0, expired: { true },
        query: { _, _ in
          XCTFail("No search after deadline")
          return []
        })?.count, 5000)
  }
}
