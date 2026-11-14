import XCTest
@testable import F5ComputerCore

final class EventBatchTests: XCTestCase {
  enum Validation: Error { case blocked }
  func testPreflightFailurePostsNothing() {
    var posts = 0
    XCTAssertThrowsError(try computerRunEventBatch(count: 2,
      validate: { throw Validation.blocked }, post: { _ in posts += 1 })) {
      XCTAssertTrue($0 is Validation)
    }
    XCTAssertEqual(posts, 0)
  }
  func testSecondChordFailureIsUnknownAndNeverReplayed() {
    var checks = 0
    var posts: [Int] = []
    XCTAssertThrowsError(try computerRunEventBatch(count: 3,
      validate: { checks += 1; if checks == 2 { throw Validation.blocked } },
      post: { posts.append($0) })) {
      XCTAssertTrue($0 is ComputerEventBatchError)
    }
    XCTAssertEqual(posts, [0])
  }
}
