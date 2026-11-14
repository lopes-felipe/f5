import CoreGraphics
import XCTest

@testable import F5ComputerCore

final class ExecutionPermitsTests: XCTestCase {
  func testIndependentGenerationsStartSuspendedAndExpireOnce() {
    let permits = ExecutionPermits()
    permits.arm(1, scope: .app("calc"), duration: 1, now: 10)
    permits.arm(2, scope: .app("notes"), duration: 1, now: 10)
    XCTAssertFalse(permits.authorized(1, id: "a", now: 10))
    permits.resume(1, now: 10)
    permits.resume(2, now: 10)
    XCTAssertTrue(permits.authorized(1, id: "a", now: 10.5))
    permits.suspend(1)
    XCTAssertFalse(permits.authorized(1, id: "a", now: 10.5))
    XCTAssertTrue(permits.authorized(2, id: "a", now: 10.5))
    permits.renew(2, duration: 1, now: 10.9)
    XCTAssertEqual(permits.takeExpiredGenerations(now: 12), [2])
    XCTAssertEqual(permits.takeExpiredGenerations(now: 12), [])
    XCTAssertFalse(permits.authorized(2, id: "a", now: 12))
  }
  func testSuspendAllAndPartitionedSuspension() {
    let permits = ExecutionPermits()
    permits.arm(1, scope: .app("calc"), duration: 1, now: 0)
    permits.arm(2, scope: .foreground, duration: 1, now: 0)
    permits.resume(1, now: 0)
    permits.resume(2, now: 0)
    XCTAssertEqual(permits.suspendForeground(), [2])
    XCTAssertEqual(Array(permits.activeGenerations(now: 0.5).keys), [1])
    XCTAssertEqual(permits.suspendBackground(), [1])
    permits.resume(1, now: 0.5)
    permits.suspendAll()
    XCTAssertTrue(permits.activeGenerations(now: 0.5).isEmpty)
  }
  func testRetiredGenerationsRefuseRenewAndResumeAndDropCancellations() {
    let permits = ExecutionPermits(retiredLimit: 2)
    permits.arm(3, scope: .app("calc"), duration: 1, now: 0)
    permits.resume(3, now: 0)
    permits.cancel(3, id: "a")
    XCTAssertFalse(permits.authorized(3, id: "a", now: 0))
    XCTAssertTrue(permits.authorized(3, id: "b", now: 0))
    permits.retire(3)
    permits.arm(3, scope: .app("calc"), duration: 1, now: 0)
    permits.renew(3, duration: 1, now: 0)
    permits.resume(3, now: 0)
    XCTAssertFalse(permits.authorized(3, id: "b", now: 0))
    XCTAssertTrue(permits.wasCancelled(3, id: "b"))
  }
  func testScopeIsImmutableAndRenewalsNeverCreate() {
    let permits = ExecutionPermits()
    permits.renew(5, duration: 1, now: 0)
    XCTAssertNil(permits.scope(5))
    permits.arm(5, scope: .app("calc"), duration: 1, now: 0)
    permits.arm(5, scope: .foreground, duration: 1, now: 0)
    XCTAssertEqual(permits.scope(5), .app("calc"))
    permits.resume(5, scope: .takeover("calc"), now: 0)
    XCTAssertFalse(permits.authorized(5, id: "a", now: 0))
    permits.resume(5, scope: .app("calc"), now: 0)
    XCTAssertTrue(permits.authorized(5, id: "a", now: 0))
  }
  func testScopeDecoding() {
    XCTAssertEqual(ComputerExecutionScope(nil), .foreground)
    XCTAssertEqual(ComputerExecutionScope(["kind": "app", "appId": "x"]), .app("x"))
    XCTAssertEqual(
      ComputerExecutionScope(["kind": "takeover", "appId": "x", "approvalReceipt": "r"]),
      .takeover("x"))
    XCTAssertNil(ComputerExecutionScope(["kind": "app"]))
    XCTAssertNil(ComputerExecutionScope("app"))
  }
}

final class BackgroundPolicyTests: XCTestCase {
  func testBackgroundEventsRequireCertifiedAppsAndExcludeSessionShortcuts() {
    XCTAssertFalse(computerBackgroundEventAppAllowed("unverified.example"))
    for op in ["key", "scroll"] {
      XCTAssertFalse(computerBackgroundOpAllowed(op: op, action: nil))
      XCTAssertTrue(computerBackgroundOpAllowed(op: op, action: nil, events: true))
    }
    for raw in ["Meta+Tab", "Meta+Space", "Ctrl+Left", "Control+ArrowUp", "Meta+Alt+Esc",
      "Control+Meta+Q", "Meta+Shift+3", "Meta+Shift+4", "Meta+Shift+5"] {
      XCTAssertFalse(computerBackgroundKeyAllowed(raw), raw)
    }
    for raw in ["Meta+A", "Shift+Left", "x", "Down"] {
      XCTAssertTrue(computerBackgroundKeyAllowed(raw), raw)
    }
  }
  func testScopeAllowsAcrossDeliveries() {
    XCTAssertTrue(
      computerScopeAllows(
        scope: .app("calc"), delivery: "background", op: "elementAction", appId: "calc",
        action: "press"))
    XCTAssertFalse(
      computerScopeAllows(
        scope: .app("calc"), delivery: "background", op: "elementAction", appId: "notes",
        action: "press"))
    XCTAssertFalse(
      computerScopeAllows(
        scope: .app("calc"), delivery: "background", op: "click", appId: "calc", action: nil))
    XCTAssertFalse(
      computerScopeAllows(
        scope: .app("calc"), delivery: "background", op: "activateApp", appId: "calc", action: nil))
    XCTAssertFalse(
      computerScopeAllows(
        scope: .foreground, delivery: "background", op: "type", appId: "calc", action: nil))
    XCTAssertFalse(
      computerScopeAllows(
        scope: .app("calc"), delivery: "foreground", op: "click", appId: nil, action: nil))
    XCTAssertTrue(
      computerScopeAllows(
        scope: .foreground, delivery: "foreground", op: "click", appId: nil, action: nil))
    XCTAssertTrue(
      computerScopeAllows(
        scope: .takeover("calc"), delivery: "foreground", op: "click", appId: nil, action: nil))
    XCTAssertTrue(
      computerScopeAllows(
        scope: .takeover("calc"), delivery: "foreground", op: "activateApp", appId: "calc",
        action: nil))
    XCTAssertFalse(
      computerScopeAllows(
        scope: .takeover("calc"), delivery: "foreground", op: "activateApp", appId: "notes",
        action: nil))
  }
  func testBackgroundOps() {
    for op in ["inspect", "screenshot", "zoom", "type", "openApp"] {
      XCTAssertTrue(computerBackgroundOpAllowed(op: op, action: nil), op)
    }
    for op in ["click", "move", "drag", "scroll", "key", "activateApp"] {
      XCTAssertFalse(computerBackgroundOpAllowed(op: op, action: nil), op)
    }
    XCTAssertTrue(computerBackgroundOpAllowed(op: "elementAction", action: "setValue"))
    XCTAssertFalse(computerBackgroundOpAllowed(op: "elementAction", action: "focus"))
    XCTAssertFalse(computerBackgroundOpAllowed(op: "elementAction", action: "showMenu"))
  }
  func testInputConflicts() {
    let bounds = [CGRect(x: 0, y: 0, width: 100, height: 100)]
    let inside = CGPoint(x: 10, y: 10)
    let outside = CGPoint(x: 500, y: 500)
    func conflicts(
      _ kind: ComputerInputKind, _ location: CGPoint, event: Int? = nil, cached: Int? = nil,
      front: Int? = 9, fresh: Bool = true
    ) -> Bool {
      computerInputConflicts(
        kind: kind, location: location, eventWindowOwnerPid: event, cachedOwnerAtPoint: cached,
        frontmostPid: front, targetPids: [7], targetBounds: bounds, cacheFresh: fresh)
    }
    // Clicking the window covering a non-frontmost target is not a conflict.
    XCTAssertFalse(conflicts(.pointerDown, inside, cached: 9))
    XCTAssertTrue(conflicts(.pointerDown, inside, cached: 7))
    XCTAssertTrue(conflicts(.pointerDown, outside, event: 7))
    // Stale cache or unknown owner inside target bounds: conservative.
    XCTAssertTrue(conflicts(.pointerDown, inside, cached: 9, fresh: false))
    XCTAssertTrue(conflicts(.scroll, inside))
    XCTAssertFalse(conflicts(.scroll, outside))
    XCTAssertTrue(conflicts(.drop, inside, cached: 7))
    XCTAssertTrue(conflicts(.dragStart, inside, cached: 7))
    XCTAssertFalse(conflicts(.keyDown, inside, cached: 7))
    XCTAssertTrue(conflicts(.keyDown, outside, front: 7))
    XCTAssertFalse(conflicts(.pointerMove, inside, event: 7, front: 7))
  }
  func testActivationIncident() {
    XCTAssertTrue(
      computerActivationIncident(
        beforePid: 1, afterPid: 7, targetPid: 7, windowEndUptime: 10, now: 9.9))
    XCTAssertFalse(
      computerActivationIncident(
        beforePid: 1, afterPid: 7, targetPid: 7, windowEndUptime: 10, now: 10.1))
    XCTAssertFalse(
      computerActivationIncident(
        beforePid: 7, afterPid: 7, targetPid: 7, windowEndUptime: 10, now: 9))
    XCTAssertFalse(
      computerActivationIncident(
        beforePid: 1, afterPid: 2, targetPid: 7, windowEndUptime: 10, now: 9))
  }
  func testHeldInputsDrainPerRequestAndGeneration() {
    var held = HeldComputerInputs<Int>()
    held.insert(1, owner: HeldComputerInputOwner(requestId: "a", generation: 1))
    held.insert(2, owner: HeldComputerInputOwner(requestId: "b", generation: 2))
    held.insert(3)
    XCTAssertEqual(held.drain(where: { $0.requestId == "a" }), [1, 3])
    XCTAssertEqual(held.drain(where: { $0.generation == 1 }), [])
    XCTAssertEqual(held.drain(where: { $0.generation == 2 }), [2])
    XCTAssertEqual(held.drain(), [])
  }
}
