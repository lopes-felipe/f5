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
}
