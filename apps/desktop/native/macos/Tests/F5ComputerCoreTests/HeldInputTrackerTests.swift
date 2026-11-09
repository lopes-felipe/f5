import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class HeldInputTrackerTests: XCTestCase {
  private let shift = HeldInput(.modifier, 56)
  private let rightShift = HeldInput(.modifier, 60)
  private let keyA = HeldInput(.key, 0)
  private let left = HeldInput(.button, 0)

  /// Reconcile against a HID snapshot taken now, as the helper does.
  private func held(
    _ tracker: inout HeldInputTracker, at now: TimeInterval, system: Set<HeldInput>
  ) -> [HeldInput] {
    tracker.held(now: now, sampled: tracker.sample(), systemHeld: system)
  }
  private func allDown(_ tracker: HeldInputTracker) -> Set<HeldInput> { Set(tracker.downs.keys) }

  func testDownThenUpIsNotHeld() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(keyA), now: 0)
    tracker.observe(.up(keyA), now: 0.1)
    tracker.observe(.down(left), now: 0.2)
    tracker.observe(.up(left), now: 0.3)
    tracker.observe(.down(shift), now: 0.4)
    tracker.observe(.up(shift), now: 0.5)
    XCTAssertEqual(held(&tracker, at: 1, system: [keyA, left, shift]), [])
  }

  func testCorroboratedHoldIsHeldOldestFirst() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(shift), now: 0)
    tracker.observe(.down(left), now: 1)
    tracker.observe(.down(keyA), now: 2)
    tracker.observe(.down(keyA), now: 3)  // auto-repeat keeps the first down time
    XCTAssertEqual(held(&tracker, at: 4, system: allDown(tracker)), [shift, left, keyA])
  }

  func testSystemHoldTheTapNeverSawIsNotHeld() {
    var tracker = HeldInputTracker()
    tracker.observe(.activity, now: 0)
    XCTAssertEqual(held(&tracker, at: 1, system: [shift, keyA, left]), [])
  }

  func testTappedHoldTheSystemReportsReleasedIsDropped() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(keyA), now: 0)
    tracker.observe(.down(shift), now: 0)
    XCTAssertEqual(held(&tracker, at: 1, system: [shift]), [shift])
    XCTAssertEqual(allDown(tracker), [shift])
    // The system later reporting it down again does not resurrect a dropped entry.
    XCTAssertEqual(held(&tracker, at: 1, system: [shift, keyA]), [shift])
  }

  func testStationaryModifierAndButtonHoldsKeepBlockingPastTenSeconds() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(shift), now: 0)
    tracker.observe(.down(left), now: 0.1)
    XCTAssertEqual(held(&tracker, at: 60, system: [shift, left]), [shift, left])
    XCTAssertEqual(
      held(&tracker, at: HeldInputTracker.staleAfter, system: [shift, left]), [shift, left])
  }

  func testStuckHoldStopsCountingOnlyAfterTheLongBackstop() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(shift), now: 0)
    XCTAssertEqual(held(&tracker, at: HeldInputTracker.staleAfter + 0.1, system: [shift]), [])
    // Kept, not forgotten: activity while still held reports it again.
    tracker.observe(.activity, now: 200)
    XCTAssertEqual(held(&tracker, at: 200.5, system: [shift]), [shift])
  }

  func testReleaseAndRepressAfterSamplingKeepsTheNewPress() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(left), now: 0)
    // Sampled, then HID reads released, then the user presses again before reconciliation.
    let sampled = tracker.sample()
    tracker.observe(.up(left), now: 1)
    tracker.observe(.down(left), now: 1.1)
    XCTAssertEqual(tracker.held(now: 1.2, sampled: sampled, systemHeld: []), [left])
    // A later sample of the new press still reconciles normally.
    XCTAssertEqual(held(&tracker, at: 2, system: []), [])
  }

  func testEntriesTappedAfterTheSampleAreKept() {
    var tracker = HeldInputTracker()
    let sampled = tracker.sample()
    tracker.observe(.down(keyA), now: 0)
    XCTAssertEqual(tracker.held(now: 0.1, sampled: sampled, systemHeld: []), [keyA])
  }

  func testModifierDirectionComesFromEventFlags() {
    let down = HeldInputEvent.from(
      type: .flagsChanged, keyCode: 56, flags: .maskShift, buttonNumber: 0)
    let up = HeldInputEvent.from(type: .flagsChanged, keyCode: 56, flags: [], buttonNumber: 0)
    XCTAssertEqual(down, .down(shift))
    XCTAssertEqual(up, .up(shift))
    // A release recorded right after a tap reset is an up, so a re-press is never toggled away.
    var tracker = HeldInputTracker()
    tracker.reset()
    tracker.observe(up, now: 0)
    tracker.observe(down, now: 0.1)
    XCTAssertEqual(held(&tracker, at: 0.2, system: [shift]), [shift])
  }

  func testLeftModifierReleaseWhileRightIsHeldIsCorrectedByPerKeyState() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(shift), now: 0)
    tracker.observe(.down(rightShift), now: 0.1)
    // Releasing left Shift still carries the Shift flag (right is down), so it reads as down.
    tracker.observe(
      HeldInputEvent.from(type: .flagsChanged, keyCode: 56, flags: .maskShift, buttonNumber: 0),
      now: 0.2)
    XCTAssertEqual(held(&tracker, at: 0.3, system: [rightShift]), [rightShift])
  }

  func testEventMapping() {
    func map(_ type: CGEventType, key: Int = 0, button: Int = 0) -> HeldInputEvent {
      .from(type: type, keyCode: key, flags: [], buttonNumber: button)
    }
    XCTAssertEqual(map(.keyDown, key: 0), .down(keyA))
    XCTAssertEqual(map(.keyUp, key: 0), .up(keyA))
    XCTAssertEqual(map(.leftMouseDown), .down(left))
    XCTAssertEqual(map(.rightMouseUp), .up(HeldInput(.button, 1)))
    XCTAssertEqual(map(.otherMouseDown, button: 2), .down(HeldInput(.button, 2)))
    XCTAssertEqual(map(.otherMouseUp, button: 4), .up(HeldInput(.button, 4)))
    XCTAssertEqual(map(.otherMouseDragged, button: 2), .activity)
    XCTAssertEqual(map(.mouseMoved), .activity)
    XCTAssertEqual(map(.scrollWheel), .activity)
    // Caps Lock never becomes a hold, through either event type.
    XCTAssertEqual(map(.keyDown, key: HeldInputTracker.capsLockKeyCode), .activity)
    XCTAssertEqual(
      HeldInputEvent.from(
        type: .flagsChanged, keyCode: HeldInputTracker.capsLockKeyCode, flags: .maskAlphaShift,
        buttonNumber: 0),
      .activity)
  }

  func testModifierFlags() {
    XCTAssertEqual(HeldInputTracker.modifierFlag(55), .maskCommand)
    XCTAssertEqual(HeldInputTracker.modifierFlag(54), .maskCommand)
    XCTAssertEqual(HeldInputTracker.modifierFlag(60), .maskShift)
    XCTAssertEqual(HeldInputTracker.modifierFlag(61), .maskAlternate)
    XCTAssertEqual(HeldInputTracker.modifierFlag(62), .maskControl)
    XCTAssertEqual(HeldInputTracker.modifierFlag(63), .maskSecondaryFn)
    XCTAssertNil(HeldInputTracker.modifierFlag(HeldInputTracker.capsLockKeyCode))
    XCTAssertNil(HeldInputTracker.modifierFlag(0))
  }

  func testOnlyHIDSourceEventsWithoutTheF5TagCanBePhysical() {
    XCTAssertTrue(HeldInputTracker.physical(userData: 0, sourceStateID: 1))
    XCTAssertFalse(HeldInputTracker.physical(userData: 0xF5C0, sourceStateID: 1))
    XCTAssertFalse(HeldInputTracker.physical(userData: 0, sourceStateID: 0))
    XCTAssertFalse(HeldInputTracker.physical(userData: 0, sourceStateID: -1))
    XCTAssertFalse(HeldInputTracker.physical(userData: 7, sourceStateID: 42))
  }

  func testCapsLockIsNeverHeld() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(HeldInput(.modifier, HeldInputTracker.capsLockKeyCode)), now: 0)
    tracker.observe(.down(HeldInput(.key, HeldInputTracker.capsLockKeyCode)), now: 0)
    XCTAssertTrue(tracker.downs.isEmpty)
  }

  func testResetClearsEntriesAndActivity() {
    var tracker = HeldInputTracker()
    tracker.observe(.down(keyA), now: 0)
    tracker.reset()
    XCTAssertTrue(tracker.downs.isEmpty)
    XCTAssertNil(tracker.lastPhysicalInput)
    XCTAssertEqual(held(&tracker, at: 0.1, system: [keyA]), [])
  }

  func testReportIsCappedAndDiagnosticsCarryCodesOnly() {
    var tracker = HeldInputTracker()
    for code in 0..<12 { tracker.observe(.down(HeldInput(.key, code)), now: Double(code)) }
    let result = held(&tracker, at: 12, system: allDown(tracker))
    XCTAssertEqual(result.count, HeldInputTracker.reportLimit)
    XCTAssertEqual(result.first, keyA)
    XCTAssertEqual(result.first?.diagnostic["kind"] as? String, "key")
    XCTAssertEqual(result.first?.diagnostic["code"] as? Int, 0)
    XCTAssertEqual(result.first?.diagnostic.count, 2)
  }
}
