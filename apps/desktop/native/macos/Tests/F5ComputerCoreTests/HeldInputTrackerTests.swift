import XCTest
@testable import F5ComputerCore

final class HeldInputTrackerTests: XCTestCase {
  private let shift = HeldInput(.modifier, 56)
  private let keyA = HeldInput(.key, 0)
  private let left = HeldInput(.button, 0)

  func testDownThenUpIsNotHeld() {
    var tracker = HeldInputTracker()
    tracker.observe(.keyDown(0), now: 0)
    tracker.observe(.keyUp(0), now: 0.1)
    tracker.observe(.buttonDown(0), now: 0.2)
    tracker.observe(.buttonUp(0), now: 0.3)
    tracker.observe(.modifierChanged(56), now: 0.4)
    tracker.observe(.modifierChanged(56), now: 0.5)
    XCTAssertEqual(tracker.held(now: 1) { _ in true }, [])
    XCTAssertTrue(tracker.downs.isEmpty)
  }

  func testCorroboratedRecentHoldIsHeldOldestFirst() {
    var tracker = HeldInputTracker()
    tracker.observe(.modifierChanged(56), now: 0)
    tracker.observe(.buttonDown(0), now: 1)
    tracker.observe(.keyDown(0), now: 2)
    // Auto-repeat keeps the original down time.
    tracker.observe(.keyDown(0), now: 3)
    XCTAssertEqual(tracker.held(now: 4) { _ in true }, [shift, left, keyA])
  }

  func testSystemHoldTheTapNeverSawIsNotHeld() {
    var tracker = HeldInputTracker()
    tracker.observe(.activity, now: 0)
    XCTAssertEqual(tracker.held(now: 1) { _ in true }, [])
  }

  func testTappedHoldTheSystemReportsReleasedIsDropped() {
    var tracker = HeldInputTracker()
    tracker.observe(.keyDown(0), now: 0)
    tracker.observe(.modifierChanged(56), now: 0)
    XCTAssertEqual(tracker.held(now: 1) { $0 == self.shift }, [shift])
    XCTAssertEqual(Set(tracker.downs.keys), [shift])
    // The system later reporting it down again does not resurrect a dropped entry.
    XCTAssertEqual(tracker.held(now: 1) { _ in true }, [shift])
  }

  func testMissedModifierEdgeIsCorrectedBySystemState() {
    var tracker = HeldInputTracker()
    // Only the release was tapped: the tracker reads it as a press until the system disagrees.
    tracker.observe(.modifierChanged(56), now: 0)
    XCTAssertEqual(tracker.held(now: 0.5) { _ in false }, [])
    tracker.observe(.modifierChanged(56), now: 1)
    XCTAssertEqual(tracker.held(now: 1.5) { _ in true }, [shift])
  }

  func testOnlyHardwareEventsWithoutTheF5TagArePhysical() {
    XCTAssertTrue(HeldInputTracker.physical(userData: 0, sourceStateID: 1))
    XCTAssertFalse(HeldInputTracker.physical(userData: 0xF5C0, sourceStateID: 1))
    XCTAssertFalse(HeldInputTracker.physical(userData: 0, sourceStateID: 0))
    XCTAssertFalse(HeldInputTracker.physical(userData: 0, sourceStateID: -1))
    XCTAssertFalse(HeldInputTracker.physical(userData: 7, sourceStateID: 42))
  }

  func testCapsLockIsNeverHeld() {
    var tracker = HeldInputTracker()
    tracker.observe(.modifierChanged(HeldInputTracker.capsLockKeyCode), now: 0)
    tracker.observe(.keyDown(HeldInputTracker.capsLockKeyCode), now: 0)
    XCTAssertEqual(tracker.held(now: 1) { _ in true }, [])
    XCTAssertTrue(tracker.downs.isEmpty)
  }

  func testHoldWithoutRecentPhysicalInputStopsCounting() {
    var tracker = HeldInputTracker()
    tracker.observe(.modifierChanged(56), now: 0)
    XCTAssertEqual(tracker.held(now: HeldInputTracker.staleAfter) { _ in true }, [shift])
    XCTAssertEqual(tracker.held(now: HeldInputTracker.staleAfter + 0.1) { _ in true }, [])
    // Kept, not forgotten: activity while still held reports it again.
    tracker.observe(.activity, now: 20)
    XCTAssertEqual(tracker.held(now: 20.5) { _ in true }, [shift])
  }

  func testResetClearsEntriesAndActivity() {
    var tracker = HeldInputTracker()
    tracker.observe(.keyDown(0), now: 0)
    tracker.reset()
    XCTAssertTrue(tracker.downs.isEmpty)
    XCTAssertNil(tracker.lastPhysicalInput)
    XCTAssertEqual(tracker.held(now: 0.1) { _ in true }, [])
  }

  func testReportIsCappedAndDiagnosticsCarryCodesOnly() {
    var tracker = HeldInputTracker()
    for code in 0..<12 { tracker.observe(.keyDown(code), now: Double(code)) }
    let held = tracker.held(now: 12) { _ in true }
    XCTAssertEqual(held.count, HeldInputTracker.reportLimit)
    XCTAssertEqual(held.first, keyA)
    XCTAssertEqual(held.first?.diagnostic["kind"] as? String, "key")
    XCTAssertEqual(held.first?.diagnostic["code"] as? Int, 0)
    XCTAssertEqual(held.first?.diagnostic.count, 2)
  }
}
