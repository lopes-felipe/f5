import XCTest

@testable import F5ComputerCore

final class AuthorizationTests: XCTestCase {
  func testDeviceLockExcludesAnotherBuildAndReleasesOnExit() throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
    defer { try? FileManager.default.removeItem(atPath: path) }
    var first: ComputerDeviceLock? = ComputerDeviceLock(path: path)
    XCTAssertNotNil(first)
    XCTAssertNil(ComputerDeviceLock(path: path))
    first = nil
    XCTAssertNotNil(ComputerDeviceLock(path: path))
  }
  func testCancelReleasesOnlyHeldButtonsAndModifiersOnce() {
    var held = HeldComputerInputs<Int>()
    held.insert(55)
    held.insert(0)
    held.insert(55)
    held.remove(0)
    XCTAssertEqual(held.drain(), Set([55]))
    XCTAssertTrue(held.drain().isEmpty)
  }
  func testCatalogProtectsEveryF5ChannelAndCommandApps() {
    for id in [
      "com.t3tools.t3code", "com.t3tools.t3code.beta", "com.github.Electron",
      "com.apple.SecurityAgent",
    ] {
      XCTAssertEqual(computerAppTier(id), "blocked")
    }
    XCTAssertEqual(computerAppTier("com.1password.1password"), "view")
    XCTAssertEqual(computerAppTier("com.apple.Terminal"), "click")
    XCTAssertTrue(computerAppIsBrowser("com.google.Chrome"))
  }
  func testTierRightsAndTypingAreNotInterchangeable() {
    XCTAssertFalse(allowsComputerGrant(tier: "blocked", allowTyping: true, needed: "view"))
    XCTAssertFalse(allowsComputerGrant(tier: "view", allowTyping: true, needed: "click"))
    XCTAssertFalse(allowsComputerGrant(tier: "click", allowTyping: false, needed: "type"))
    XCTAssertTrue(allowsComputerGrant(tier: "click", allowTyping: true, needed: "type"))
    XCTAssertTrue(allowsComputerGrant(tier: "full", allowTyping: false, needed: "type"))
  }
  func testProtectedChordsIncludingKillChord() {
    XCTAssertTrue(
      blockedComputerChord(key: "esc", command: true, control: true, alt: false, shift: false))
    XCTAssertTrue(
      blockedComputerChord(key: "escape", command: true, control: false, alt: true, shift: false))
    XCTAssertTrue(
      blockedComputerChord(key: "q", command: true, control: false, alt: false, shift: true))
    XCTAssertTrue(
      blockedComputerChord(key: "space", command: true, control: false, alt: false, shift: false))
    XCTAssertFalse(
      blockedComputerChord(key: "c", command: true, control: false, alt: false, shift: false))
  }
  func testChangingOwnerStopsDragBeforeNextEvent() {
    let permit = ExecutionPermit()
    permit.renew(1, duration: 1, now: 10)
    permit.resume(1, now: 10)
    var posted = 0
    for step in 0..<12 {
      let tier = step < 4 ? "full" : "blocked"
      guard permit.authorized(1, id: "drag", now: 10),
        allowsComputerGrant(tier: tier, allowTyping: false, needed: "click")
      else { break }
      posted += 1
    }
    XCTAssertEqual(posted, 4)
  }
  func testCancelAndFocusChangeStopTypingAtChunkBoundary() {
    let permit = ExecutionPermit()
    permit.renew(1, duration: 1, now: 10)
    permit.resume(1, now: 10)
    var posted = 0
    for chunk in 0..<3 {
      let tier = chunk == 0 ? "full" : "view"
      guard allowsComputerGrant(tier: tier, allowTyping: false, needed: "type") else { break }
      for _ in 0..<32 {
        guard permit.authorized(1, id: "type", now: 10) else { break }
        posted += 1
        if posted == 5 { permit.cancel("type") }
      }
    }
    XCTAssertEqual(posted, 5)
  }
  func testExpiryNotificationOnlyForResumedGeneration() {
    let permit = ExecutionPermit()
    let now = ProcessInfo.processInfo.systemUptime
    permit.renew(4, duration: 1, now: now)
    XCTAssertNil(permit.takeExpiredGeneration())
    permit.resume(4, now: now)
    XCTAssertFalse(permit.authorized(4, id: "type", now: now + 2))
    XCTAssertEqual(permit.takeExpiredGeneration(), 4)
    XCTAssertNil(permit.takeExpiredGeneration())
  }
  func testUnknownOwnersAndSystemSurfacesFailClosedEvenWhenGranted() {
    XCTAssertEqual(
      computerTargetBlock(appId: nil, pid: 20, f5Pids: [], helperPid: 1), "owner-unknown")
    XCTAssertEqual(
      computerTargetBlock(appId: "com.example.Notes", pid: 20, f5Pids: [20], helperPid: 1), "f5")
    XCTAssertEqual(
      computerTargetBlock(appId: "com.example.Notes", pid: 1, f5Pids: [], helperPid: 1), "f5")
    for id in [
      "com.apple.dock", "com.apple.controlcenter", "com.apple.notificationcenterui",
      "com.apple.spotlight",
    ] {
      XCTAssertEqual(computerTargetBlock(appId: id, pid: 20, f5Pids: [], helperPid: 1), "system-ui")
    }
    XCTAssertNil(computerTargetBlock(appId: "com.example.Notes", pid: 20, f5Pids: [], helperPid: 1))
  }
  func testKeyboardRefusesUnknownFocusAndSecureFields() {
    XCTAssertEqual(
      computerFocusBlock(
        frontPid: 20, focusedPid: nil, secureInput: false, role: "AXTextField", subrole: nil),
      "owner-unknown")
    XCTAssertEqual(
      computerFocusBlock(
        frontPid: 20, focusedPid: 21, secureInput: false, role: "AXTextField", subrole: nil),
      "owner-unknown")
    XCTAssertEqual(
      computerFocusBlock(frontPid: 20, focusedPid: 20, secureInput: false, role: nil, subrole: nil),
      "focus-unknown")
    for (secure, role, subrole) in [
      (true, "AXTextField", ""), (false, "AXSecureTextField", ""),
      (false, "AXTextField", "AXSecureTextField"),
    ] {
      XCTAssertEqual(
        computerFocusBlock(
          frontPid: 20, focusedPid: 20, secureInput: secure, role: role, subrole: subrole),
        "secure-field")
    }
    XCTAssertNil(
      computerFocusBlock(
        frontPid: 20, focusedPid: 20, secureInput: false, role: "AXTextField", subrole: nil))
  }
  func testModalOrElementChangeStopsTypingEvenInTheSameGrantedApp() {
    XCTAssertFalse(
      computerFocusUnchanged(
        initialPid: 20, currentPid: 20, sameWindow: false, sameElement: true, typing: true))
    XCTAssertFalse(
      computerFocusUnchanged(
        initialPid: 20, currentPid: 20, sameWindow: true, sameElement: false, typing: true))
    XCTAssertFalse(
      computerFocusUnchanged(
        initialPid: 20, currentPid: 21, sameWindow: true, sameElement: true, typing: true))
    XCTAssertTrue(
      computerFocusUnchanged(
        initialPid: 20, currentPid: 20, sameWindow: true, sameElement: false, typing: false))
  }
  func testMenuAuthorizationExcludesStatusItemsAndUnknownGeometry() {
    XCTAssertTrue(computerMenuPointAllowed(x: -100, left: -200, lastItemRight: 0))
    XCTAssertFalse(computerMenuPointAllowed(x: 0, left: -200, lastItemRight: 0))
    XCTAssertFalse(computerMenuPointAllowed(x: -201, left: -200, lastItemRight: 0))
    XCTAssertFalse(computerMenuPointAllowed(x: 100, left: 100, lastItemRight: 100))
    XCTAssertFalse(computerMenuPointAllowed(x: .nan, left: 0, lastItemRight: 100))
  }

}
