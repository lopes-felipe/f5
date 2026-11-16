import CoreGraphics
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
      "io.github.lopesfelipe.f5", "io.github.lopesfelipe.f5.dev",
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
  func testMenuAuthorizationExcludesAppleMenuGapsAndUnknownGeometry() {
    let items: [CGRect?] = [
      CGRect(x: -200, y: 0, width: 20, height: 24),
      CGRect(x: -170, y: 0, width: 50, height: 24), CGRect(x: -110, y: 0, width: 40, height: 24),
    ]
    XCTAssertFalse(computerMenuPointAllowed(x: -190, y: 12, items: items))
    XCTAssertTrue(computerMenuPointAllowed(x: -150, y: 12, items: items))
    XCTAssertFalse(computerMenuPointAllowed(x: -175, y: 12, items: items))
    XCTAssertFalse(computerMenuPointAllowed(x: -70, y: 12, items: items))
    XCTAssertFalse(computerMenuPointAllowed(x: -150, y: 24, items: items))
    XCTAssertFalse(computerMenuPointAllowed(x: .nan, y: 0, items: items))
    XCTAssertFalse(computerMenuPointAllowed(x: -150, y: 12, items: [nil, items[1]]))
  }

  func testMouseDownRecipientUsesSelectedWindowNotRectangleOrder() {
    // A full-display Dock rectangle can precede the actual app in the compositor list.
    let owners = [10: 200, 11: 300, 12: 400]
    XCTAssertEqual(computerRecipientPid(windowId: 11, owners: owners, overlayWindowIds: []), 300)
    XCTAssertEqual(
      computerTargetBlock(appId: "com.apple.dock", pid: 200, f5Pids: [], helperPid: 1),
      "system-ui")
    // Conversely, an actual protected recipient cannot be replaced with the granted app.
    XCTAssertEqual(computerRecipientPid(windowId: 10, owners: owners, overlayWindowIds: []), 200)
    XCTAssertEqual(computerRecipientPid(windowId: 12, owners: owners, overlayWindowIds: []), 400)
    XCTAssertEqual(
      computerTargetBlock(appId: "com.example.F5", pid: 400, f5Pids: [400], helperPid: 1), "f5")
  }
  func testUnknownStaleAndUnexpectedOverlayRecipientsFailClosed() {
    let owners = [10: 200, 11: 0]
    XCTAssertNil(computerRecipientPid(windowId: 0, owners: owners, overlayWindowIds: []))
    XCTAssertNil(computerRecipientPid(windowId: -1, owners: owners, overlayWindowIds: []))
    XCTAssertNil(computerRecipientPid(windowId: 12, owners: owners, overlayWindowIds: []))
    XCTAssertNil(computerRecipientPid(windowId: 11, owners: owners, overlayWindowIds: []))
    XCTAssertNil(computerRecipientPid(windowId: 10, owners: owners, overlayWindowIds: [10]))
  }
  func testMouseDownCoordinatesPreserveNegativeOriginsAndUsePrimaryHeight() {
    for (x, y, expectedY) in [
      (100.0, 50.0, 850.0), (-100.0, -200.0, 1100.0), (1200.0, 1000.0, -100.0),
    ] {
      let point = computerAppKitCoordinates(x: x, y: y, primaryDisplayHeight: 900)
      XCTAssertEqual(point.x, x)
      XCTAssertEqual(point.y, expectedY)
    }
  }

  func testOwnershipChangingToF5OrUnknownCannotReuseThePreviousRecipient() {
    let recipients: [(Int, [Int: Int], String?)] = [
      (10, [10: 200], "com.example.Notes"),
      (10, [10: 300], "com.t3tools.t3code.beta"),
      (10, [:], nil),
    ]
    var delivered = 0
    for (window, owners, app) in recipients {
      guard let pid = computerRecipientPid(windowId: window, owners: owners, overlayWindowIds: []),
        computerTargetBlock(appId: app, pid: pid, f5Pids: [300], helperPid: 1) == nil else { break }
      delivered += 1
    }
    XCTAssertEqual(delivered, 1)
    XCTAssertNil(computerRecipientPid(windowId: 10, owners: [:], overlayWindowIds: []))
  }

  func testFocusBecomingSecureBetweenEventsStopsBeforeTheNextDelivery() {
    let focus = [
      (20, false, "AXTextField"), (20, false, "AXSecureTextField"),
      (21, false, "AXTextField"),
    ]
    var delivered = 0
    for (pid, secure, role) in focus {
      guard computerFocusBlock(frontPid: 20, focusedPid: pid, secureInput: secure,
        role: role, subrole: nil) == nil else { break }
      delivered += 1
    }
    XCTAssertEqual(delivered, 1)
  }

  func testRevokedGrantCannotAuthorizeSemanticOrCoordinateActions() {
    for needed in ["click", "type"] {
      XCTAssertFalse(allowsComputerGrant(tier: "view", allowTyping: true, needed: needed))
      XCTAssertFalse(allowsComputerGrant(tier: "blocked", allowTyping: true, needed: needed))
    }
    XCTAssertFalse(allowsComputerGrant(tier: "full", allowTyping: true, needed: "arbitrary"))
  }

}
