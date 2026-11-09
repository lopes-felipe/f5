import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class HeldInputTrackerTests: XCTestCase {
  private let shift = HeldInput(.modifier, 56)
  private let rightShift = HeldInput(.modifier, 60)
  private let keyA = HeldInput(.key, 0)
  private let left = HeldInput(.button, 0)

  /// Samples the tracker, asks `system` about each entry, then reconciles, as the helper does.
  private func held(
    _ tracker: inout HeldInputTracker, now: TimeInterval, system: (HeldInput) -> Bool
  ) -> [HeldInput] {
    let released = tracker.downs.filter { !system($0.key) }.mapValues(\.revision)
    return tracker.held(now: now, released: released)
  }

  func testDownThenUpIsNotHeld() {
    var tracker = HeldInputTracker()
    tracker.observe(.keyDown(0), now: 0)
    tracker.observe(.keyUp(0), now: 0.1)
    tracker.observe(.buttonDown(0), now: 0.2)
    tracker.observe(.buttonUp(0), now: 0.3)
    tracker.observe(.modifierChanged(56, down: true), now: 0.4)
    tracker.observe(.modifierChanged(56, down: false), now: 0.5)
    XCTAssertEqual(held(&tracker, now: 1) { _ in true }, [])
    XCTAssertTrue(tracker.downs.isEmpty)
  }

  func testCorroboratedRecentHoldIsHeldOldestFirst() {
    var tracker = HeldInputTracker()
    tracker.observe(.modifierChanged(56, down: true), now: 0)
    tracker.observe(.buttonDown(0), now: 1)
    tracker.observe(.keyDown(0), now: 2)
    // Auto-repeat keeps the original down time.
    tracker.observe(.keyDown(0), now: 3)
    XCTAssertEqual(held(&tracker, now: 4) { _ in true }, [shift, left, keyA])
  }

  func testSystemHoldTheTapNeverSawIsNotHeld() {
    var tracker = HeldInputTracker()
    tracker.observe(.activity, now: 0)
    XCTAssertEqual(held(&tracker, now: 1) { _ in true }, [])
  }

  func testTappedHoldTheSystemReportsReleasedIsDropped() {
    var tracker = HeldInputTracker()
    tracker.observe(.keyDown(0), now: 0)
    tracker.observe(.modifierChanged(56, down: true), now: 0)
    XCTAssertEqual(held(&tracker, now: 1) { $0 == self.shift }, [shift])
    XCTAssertEqual(Set(tracker.downs.keys), [shift])
    // The system later reporting it down again does not resurrect a dropped entry.
    XCTAssertEqual(held(&tracker, now: 1) { _ in true }, [shift])
  }

  func testReleaseAndRepressDuringReconciliationKeepsTheNewHold() {
    var tracker = HeldInputTracker()
    tracker.observe(.buttonDown(0), now: 0)
    tracker.observe(.modifierChanged(56, down: true), now: 0)
    // Sampled, then the system query sees both released...
    let released = tracker.downs.mapValues(\.revision)
    // ...while the user releases and presses them again before reconciliation.
    tracker.observe(.buttonUp(0), now: 1)
    tracker.observe(.buttonDown(0), now: 1.1)
    tracker.observe(.modifierChanged(56, down: false), now: 1.2)
    tracker.observe(.modifierChanged(56, down: true), now: 1.3)
    XCTAssertEqual(tracker.held(now: 2, released: released), [left, shift])
    // An entry unchanged since sampling is dropped.
    let sampled = tracker.downs.filter { $0.key == left }.mapValues(\.revision)
    XCTAssertEqual(tracker.held(now: 3, released: sampled), [shift])
  }

  func testModifierDirectionComesFromTheEventNotToggling() {
    var tracker = HeldInputTracker()
    // Shift was held across a tap reset: its release arrives first and must not count.
    tracker.observe(.modifierChanged(56, down: false), now: 0)
    XCTAssertEqual(held(&tracker, now: 0.5) { _ in true }, [])
    // A re-press before the next reconciliation is a hold, not a toggle back to released.
    tracker.observe(.modifierChanged(56, down: true), now: 1)
    tracker.observe(.modifierChanged(56, down: true), now: 1.1)
    XCTAssertEqual(held(&tracker, now: 1.5) { _ in true }, [shift])
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
    tracker.observe(.modifierChanged(HeldInputTracker.capsLockKeyCode, down: true), now: 0)
    tracker.observe(.keyDown(HeldInputTracker.capsLockKeyCode), now: 0)
    let capsOn = CGEventFlags.maskAlphaShift.rawValue
    XCTAssertEqual(
      HeldInputEvent(type: .flagsChanged, keyCode: 57, buttonNumber: 0, flags: capsOn), .activity)
    XCTAssertEqual(held(&tracker, now: 1) { _ in true }, [])
    XCTAssertTrue(tracker.downs.isEmpty)
  }

  func testStationaryModifierAndButtonHoldsNeverGoStale() {
    var tracker = HeldInputTracker()
    tracker.observe(.modifierChanged(56, down: true), now: 0)
    tracker.observe(.buttonDown(0), now: 0)
    // No further events: a held Cmd or a stationary press sends none. Equal down times sort by
    // kind, so the button comes first.
    XCTAssertEqual(
      held(&tracker, now: HeldInputTracker.staleAfter * 10) { _ in true }, [left, shift])
  }

  func testKeyHoldWithoutRecentPhysicalInputStopsCounting() {
    var tracker = HeldInputTracker()
    tracker.observe(.keyDown(0), now: 0)
    XCTAssertEqual(held(&tracker, now: HeldInputTracker.staleAfter) { _ in true }, [keyA])
    XCTAssertEqual(held(&tracker, now: HeldInputTracker.staleAfter + 0.1) { _ in true }, [])
    // Kept, not forgotten: activity while still held reports it again.
    tracker.observe(.activity, now: 200)
    XCTAssertEqual(held(&tracker, now: 200.5) { _ in true }, [keyA])
  }

  func testResetClearsEntriesAndActivity() {
    var tracker = HeldInputTracker()
    tracker.observe(.keyDown(0), now: 0)
    tracker.reset()
    XCTAssertTrue(tracker.downs.isEmpty)
    XCTAssertNil(tracker.lastPhysicalInput)
    XCTAssertEqual(held(&tracker, now: 0.1) { _ in true }, [])
  }

  func testReportIsCappedAndDiagnosticsCarryCodesOnly() {
    var tracker = HeldInputTracker()
    for code in 0..<12 { tracker.observe(.keyDown(code), now: Double(code)) }
    let reported = held(&tracker, now: 12) { _ in true }
    XCTAssertEqual(reported.count, HeldInputTracker.reportLimit)
    XCTAssertEqual(reported.first, keyA)
    XCTAssertEqual(reported.first?.diagnostic["kind"] as? String, "key")
    XCTAssertEqual(reported.first?.diagnostic["code"] as? Int, 0)
    XCTAssertEqual(reported.first?.diagnostic.count, 2)
  }

  func testTappedEventsMapToHeldInputEvents() {
    func event(_ type: CGEventType, keyCode: Int = 0, button: Int = 0, flags: UInt64 = 0)
      -> HeldInputEvent
    {
      HeldInputEvent(type: type, keyCode: keyCode, buttonNumber: button, flags: flags)
    }
    XCTAssertEqual(event(.keyDown, keyCode: 12), .keyDown(12))
    XCTAssertEqual(event(.keyUp, keyCode: 12), .keyUp(12))
    XCTAssertEqual(event(.leftMouseDown), .buttonDown(0))
    XCTAssertEqual(event(.rightMouseUp), .buttonUp(1))
    XCTAssertEqual(event(.otherMouseDown, button: 2), .buttonDown(2))
    XCTAssertEqual(event(.otherMouseUp, button: 4), .buttonUp(4))
    XCTAssertEqual(event(.otherMouseDragged, button: 2), .activity)
    XCTAssertEqual(event(.mouseMoved), .activity)
    let leftShiftDown = CGEventFlags.maskShift.rawValue | 0x2
    XCTAssertEqual(
      event(.flagsChanged, keyCode: 56, flags: leftShiftDown), .modifierChanged(56, down: true))
    XCTAssertEqual(event(.flagsChanged, keyCode: 56, flags: 0), .modifierChanged(56, down: false))
    XCTAssertEqual(event(.flagsChanged, keyCode: 99), .activity)
  }

  func testModifierStateDistinguishesLeftAndRightKeys() {
    let rightShiftOnly = CGEventFlags.maskShift.rawValue | 0x4
    XCTAssertEqual(ModifierKey.isDown(60, flags: rightShiftOnly), true)
    XCTAssertEqual(ModifierKey.isDown(56, flags: rightShiftOnly), false)
    // Without device-dependent bits either key falls back to the shared mask.
    XCTAssertEqual(ModifierKey.isDown(56, flags: CGEventFlags.maskShift.rawValue), true)
    XCTAssertEqual(ModifierKey.isDown(62, flags: CGEventFlags.maskControl.rawValue | 0x2000), true)
    XCTAssertEqual(ModifierKey.isDown(59, flags: CGEventFlags.maskControl.rawValue | 0x2000), false)
    XCTAssertEqual(ModifierKey.isDown(63, flags: CGEventFlags.maskSecondaryFn.rawValue), true)
    XCTAssertNil(ModifierKey.isDown(HeldInputTracker.capsLockKeyCode, flags: 0))
    XCTAssertNil(ModifierKey.isDown(12, flags: 0))
  }

  func testSystemCorroborationReadsTheMatchingState() {
    let rightShiftOnly = CGEventFlags.maskShift.rawValue | 0x4
    let noKeys: (CGKeyCode) -> Bool = { _ in false }
    let noButtons: (CGMouseButton) -> Bool = { _ in false }
    XCTAssertFalse(
      shift.systemReportsDown(flags: rightShiftOnly, keyDown: noKeys, buttonDown: noButtons))
    XCTAssertTrue(
      rightShift.systemReportsDown(flags: rightShiftOnly, keyDown: noKeys, buttonDown: noButtons))
    XCTAssertTrue(keyA.systemReportsDown(flags: 0, keyDown: { $0 == 0 }, buttonDown: noButtons))
    XCTAssertTrue(
      HeldInput(.button, 1).systemReportsDown(
        flags: 0, keyDown: noKeys, buttonDown: { $0 == .right }))
    XCTAssertFalse(left.systemReportsDown(flags: 0, keyDown: noKeys, buttonDown: { $0 == .right }))
  }
}
