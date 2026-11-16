import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class TargetWatchTests: XCTestCase {
  func testActivitySurvivesRetiringAllGenerationsAndContinuousScrollResetsAge() {
    var watch = ComputerTargetWatch()
    watch.owners.insert("profile/thread/session")
    watch.identity(pids: [41], frontmost: false, now: 0)
    let permits = ExecutionPermits()
    permits.arm(1, scope: .app("target"), duration: 1, now: 0)
    permits.resume(1, now: 0)
    permits.retire(1)
    for tick in 1...20 {
      let now = Double(tick)
      if computerInputConflicts(kind: .scroll, location: CGPoint(x: 5, y: 5),
        eventWindowOwnerPid: 41, cachedOwnerAtPoint: 41, frontmostPid: 99,
        targetPids: [41], targetBounds: [], cacheFresh: true) {
        watch.activity(now: now)
      }
      XCTAssertEqual(watch.activityAgeMs(now: now + 1), 1000)
    }
    XCTAssertEqual(watch.activityEpoch, 21)
    XCTAssertEqual(watch.activityAgeMs(now: 22), 2000)
    XCTAssertFalse(permits.authorized(1, id: "old", now: 22))
  }
  func testBriefForegroundReentryAndProcessReplacementChangeEpoch() {
    var watch = ComputerTargetWatch()
    watch.identity(pids: [41], frontmost: false, now: 0)
    let epoch = watch.activityEpoch
    watch.identity(pids: [41], frontmost: true, now: 0.1)
    watch.identity(pids: [41], frontmost: false, now: 0.2)
    XCTAssertEqual(watch.activityEpoch, epoch + 2)
    XCTAssertEqual(watch.activityAgeMs(now: 0.2), 0)
    watch.identity(pids: [42], frontmost: false, now: 1)
    XCTAssertEqual(watch.activityEpoch, epoch + 3)
  }
  func testPointerMovementAndTypingElsewhereDoNotDelayBackgroundEligibility() {
    var watch = ComputerTargetWatch()
    watch.identity(pids: [41], frontmost: false, now: 0)
    let epoch = watch.activityEpoch
    for kind in [ComputerInputKind.pointerMove, .keyDown] {
      if computerInputConflicts(kind: kind, location: CGPoint(x: 5, y: 5),
        eventWindowOwnerPid: 99, cachedOwnerAtPoint: 99, frontmostPid: 99,
        targetPids: [41], targetBounds: [CGRect(x: 0, y: 0, width: 10, height: 10)], cacheFresh: true) {
        watch.activity(now: 1)
      }
    }
    XCTAssertEqual(watch.activityEpoch, epoch)
    XCTAssertEqual(watch.activityAgeMs(now: 2), 2000)
  }
}
