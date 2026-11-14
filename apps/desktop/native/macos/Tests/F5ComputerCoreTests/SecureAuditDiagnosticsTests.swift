import CoreGraphics
import XCTest

@testable import F5ComputerCore

final class SecureAuditDiagnosticsTests: XCTestCase {
  typealias Node = ComputerSecureAuditNode<Int>
  let frame = CGRect(x: 0, y: 0, width: 100, height: 100)
  var tree: [Int: Node] {
    [
      0: Node(role: "AXWindow", frame: frame, children: [1]),
      1: Node(role: "AXWebArea", frame: frame, children: [2]),
      2: Node(role: "AXGroup", frame: frame, children: [3]),
      3: Node(role: "AXSecureTextField", frame: frame),
    ]
  }

  func testWalkingCutoffsExplainWhyMaskingWasRequired() {
    for reason in [
      ComputerSecureAuditDiagnostics.StopReason.nodeBudget, .depthLimit,
      .unreadableNode, .unreadableChildren, .secureFieldWithoutFrame, .deadline,
    ] {
      var nodes = tree
      if reason == .unreadableNode { nodes[2] = nil }
      if reason == .unreadableChildren { nodes[2]?.childrenReadable = false }
      if reason == .secureFieldWithoutFrame { nodes[3]?.frame = nil }
      let diagnostics = ComputerSecureAuditDiagnostics()
      let audit = computerSecureAudit(
        root: 0, read: { nodes[$0] }, maxDepth: reason == .depthLimit ? 2 : 256,
        maxNodes: reason == .nodeBudget ? 3 : 20000,
        expired: { reason == .deadline && diagnostics.visitedNodes >= 3 },
        diagnostics: diagnostics)
      XCTAssertEqual(audit?.complete, false, reason.rawValue)
      XCTAssertEqual(diagnostics.stopReasons, [reason], reason.rawValue)
      XCTAssertGreaterThan(diagnostics.visitedNodes, 0)
    }
  }

  func testUnreadableSubroleIsReportedWithoutForcingAMask() {
    XCTAssertEqual(
      ComputerSecureAuditDiagnostics.StopReason.unreadableSubrole.rawValue, "unreadable-subrole")
    var nodes = tree
    nodes[2]?.subroleReadable = false
    let diagnostics = ComputerSecureAuditDiagnostics()
    let audit = computerSecureAudit(
      root: 0, read: { nodes[$0] }, maxDepth: 256, maxNodes: 20000, expired: { false },
      diagnostics: diagnostics)
    XCTAssertEqual(audit, ComputerSecureAudit(rects: [frame], complete: true))
    XCTAssertEqual(diagnostics.stopReasons, [.unreadableSubrole])
  }

  func testRootSearchFallbackAndWalkDeadlineAreDistinguishable() {
    let nodes = tree
    let diagnostics = ComputerSecureAuditDiagnostics()
    let audit = computerSecureAudit(
      root: 0, read: { nodes[$0] }, maxDepth: 256, maxNodes: 20000,
      expired: { diagnostics.searchFallbacks > 0 },
      search: { root in
        computerSearchWebArea(root: root, expired: { false }, diagnostics: diagnostics) { _, _ in
          nil
        }
      }, diagnostics: diagnostics)
    XCTAssertEqual(audit?.complete, false)
    XCTAssertEqual(diagnostics.textFieldQueries, 1)
    XCTAssertEqual(diagnostics.frameQueries, 0)
    XCTAssertEqual(diagnostics.searchFallbacks, 1)
    XCTAssertEqual(diagnostics.stopReasons, [.deadline])
  }

  func testSearchFailureSentinelRetainsItsActualReason() {
    for reason in [
      ComputerSecureAuditDiagnostics.StopReason.deadline, .searchIncomplete, .searchLimit,
    ] {
      let nodes = tree
      let diagnostics = ComputerSecureAuditDiagnostics()
      let audit = computerSecureAudit(
        root: 0, read: { nodes[$0] }, maxDepth: 256, maxNodes: 20000,
        expired: { false },
        search: { root in
          computerSearchWebArea(
            root: root, expired: { reason == .deadline }, diagnostics: diagnostics
          ) { id, key in
            if reason == .searchLimit { return Array(repeating: 2, count: 5000) }
            if id == root { return key == "AXFrameSearchKey" ? [2] : [] }
            return nil
          }
        }, diagnostics: diagnostics)
      XCTAssertEqual(audit?.complete, false)
      XCTAssertEqual(diagnostics.stopReasons, [reason])
    }
  }

  func testSuccessfulSearchCountsFieldsAndFramesWithoutReadingWebChildren() {
    let nodes = tree
    let diagnostics = ComputerSecureAuditDiagnostics()
    var read: [Int] = []
    let audit = computerSecureAudit(
      root: 0,
      read: {
        read.append($0)
        return nodes[$0]
      }, maxDepth: 256, maxNodes: 20000,
      expired: { false },
      search: { root in
        computerSearchWebArea(root: root, expired: { false }, diagnostics: diagnostics) { id, key in
          key == "AXTextFieldSearchKey" ? [3] : id == root ? [2] : []
        }
      }, diagnostics: diagnostics)
    XCTAssertEqual(audit?.complete, true)
    XCTAssertEqual(diagnostics.textFieldQueries, 2)
    XCTAssertEqual(diagnostics.frameQueries, 2)
    XCTAssertEqual(diagnostics.searchResults, 3)
    XCTAssertEqual(diagnostics.visitedNodes, read.count)
    XCTAssertEqual(diagnostics.searchFallbacks, 0)
    XCTAssertTrue(diagnostics.stopReasons.isEmpty)
  }

  func testAXFailuresAreAggregatedAndBounded() {
    let diagnostics = ComputerSecureAuditDiagnostics()
    diagnostics.axFailure(.textFields, error: -25205)
    diagnostics.axFailure(.textFields, error: -25205)
    XCTAssertEqual(diagnostics.axFailures.count, 1)
    XCTAssertEqual(diagnostics.axFailures.first?.count, 2)
    for code in 0..<100 { diagnostics.axFailure(.nodeRead, error: code) }
    XCTAssertEqual(diagnostics.axFailures.count, 32)
    diagnostics.axFailure(.textFields, error: -25205)
    XCTAssertEqual(diagnostics.axFailures.first?.count, 3)
  }

  func testSubMillisecondReadsAccumulateBeforeRounding() {
    let diagnostics = ComputerSecureAuditDiagnostics()
    for _ in 0..<16 {
      diagnostics.nodeReadDuration(seconds: 0.00025)
      diagnostics.searchDuration(seconds: 0.00025)
    }
    XCTAssertEqual(diagnostics.nodeReadElapsedMs, 4)
    XCTAssertEqual(diagnostics.searchElapsedMs, 4)
  }
}
