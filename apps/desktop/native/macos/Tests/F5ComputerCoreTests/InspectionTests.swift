import ApplicationServices
import XCTest

@testable import F5ComputerCore

final class InspectionTests: XCTestCase {
  func testByteBudgetReturnsPartialUnicodeTreesBelowControllerLimit() throws {
    let label = String(repeating: "漢🙂", count: 100)
    var budget = ComputerInspectByteBudget()
    var nodes: [[String: Any]] = []
    let truncated = try computerInspectWalk(root: 0, maxNodes: 800, stop: { budget.exceeded }) {
      index in
      let node: [String: Any] = [
        "elementRef": "e\(index)", "role": "AXStaticText", "name": label,
        "value": label, "focused": false, "enabled": true, "actions": [],
      ]
      guard try budget.include(node) else { return ([index + 1], false) }
      nodes.append(node)
      return ([index + 1], true)
    }
    XCTAssertTrue(truncated)
    XCTAssertTrue(budget.exceeded)
    XCTAssertGreaterThan(nodes.count, 0)
    XCTAssertLessThan(nodes.count, 800)
    let payload: [String: Any] = [
      "snapshotId": "s", "appId": "app", "accessible": true,
      "truncated": true, "nodes": nodes,
    ]
    XCTAssertLessThan(try JSONSerialization.data(withJSONObject: payload).count, 512 * 1024)
    var huge = ComputerInspectByteBudget()
    XCTAssertFalse(try huge.include(["value": String(repeating: "a", count: 512 * 1024)]))
    XCTAssertTrue(huge.exceeded)
  }
  func testDeepInspectedControlCanBeValidatedAndCyclesTerminate() {
    var deepest = 0
    XCTAssertFalse(
      computerInspectWalk(root: 0, maxNodes: 400, stop: { false }) { depth in
        deepest = depth
        return (
          depth < computerInspectMaxVisited - 1 ? [depth + 1] : [],
          depth == computerInspectMaxVisited - 1
        )
      })
    XCTAssertEqual(deepest, 3999)
    XCTAssertTrue(computerHasAncestor(ancestor: 0, element: deepest) { $0 > 0 ? $0 - 1 : nil })
    XCTAssertFalse(computerHasAncestor(ancestor: 0, element: 4) { $0 == 4 ? 5 : 4 })
    XCTAssertFalse(computerHasAncestor(ancestor: 0, element: 1) { $0 + 1 })
  }
  func testAncestryUsesAXHandleEqualityRatherThanObjectIdentity() {
    let window = AXUIElementCreateApplication(getpid())
    let alias = AXUIElementCreateApplication(getpid())
    XCTAssertTrue(CFEqual(window, alias))
    XCTAssertTrue(computerHasAncestor(ancestor: window, element: alias) { _ in nil })
  }
  func testAncestryPreservesRequestDeadlineErrors() {
    enum Deadline: Error { case expired }
    XCTAssertThrowsError(
      try computerHasAncestor(ancestor: 0, element: 100) { _ in throw Deadline.expired })
  }
  func testSnapshotsRetainRecentRefsPerOwnerAndBoundTotalMemory() {
    let first = (0..<8).map { (owner: "a", id: $0) }
    let second = (0..<8).map { (owner: "b", id: $0) }
    let retained = computerRetainSnapshots(first + second) { $0.owner }
    XCTAssertEqual(retained.count, 16)
    XCTAssertEqual(retained.filter { $0.owner == "a" }.map(\.id), Array(0..<8))
    let more = computerRetainSnapshots(retained + [(owner: "b", id: 8)]) { $0.owner }
    XCTAssertEqual(more.filter { $0.owner == "a" }.map(\.id), Array(0..<8))
    XCTAssertEqual(more.filter { $0.owner == "b" }.map(\.id), Array(1...8))
    XCTAssertEqual(computerRetainSnapshots(Array(0..<100)) { String($0) }.count, 32)
  }
  func testOnlyEmptyUnfocusedWrappersWithWeakActionsArePruned() {
    for role in ["AXGroup", "AXUnknown", "AXGenericElement"] {
      XCTAssertTrue(
        computerInspectIsWrapper(role: role, name: "", value: nil, focused: false, actions: []))
      XCTAssertTrue(
        computerInspectIsWrapper(
          role: role, name: "", value: "", focused: false, actions: ["showMenu", "scrollIntoView"]))
      XCTAssertFalse(
        computerInspectIsWrapper(
          role: role, name: "Drawer", value: nil, focused: false, actions: []))
      XCTAssertFalse(
        computerInspectIsWrapper(role: role, name: "", value: "text", focused: false, actions: []))
      XCTAssertFalse(
        computerInspectIsWrapper(role: role, name: "", value: nil, focused: true, actions: []))
      XCTAssertFalse(
        computerInspectIsWrapper(
          role: role, name: "", value: nil, focused: false, actions: ["press"]))
    }
    XCTAssertFalse(
      computerInspectIsWrapper(role: "AXButton", name: "", value: nil, focused: false, actions: []))
  }
  func testWrapperDescendantsRemainInDepthFirstOrderAndOnlyUsefulNodesSpendBudget() {
    var visited: [Int] = []
    let truncated = computerInspectWalk(root: 0, maxNodes: 2, stop: { false }) { id in
      visited.append(id)
      return (id == 0 ? [1, 2] : id == 1 ? [3] : [], id != 0 && id != 1)
    }
    XCTAssertEqual(visited, [0, 1, 3, 2])
    XCTAssertFalse(truncated)
  }
  func testLargeRowContainerListsVisibleRowsSoLaterSiblingsAreReached() {
    // Window(0) > [table(1) with 12,000 rows, button(2)]; rows 0..<20 are visible.
    let rows = Array(1000..<13000)
    let column = 3
    func walk(items: ComputerSecureAuditRowItems<Int>?) -> (visited: [Int], truncated: Bool) {
      var visited: [Int] = []
      let truncated = computerInspectWalk(root: 0, maxNodes: 400, stop: { false }) { id in
        visited.append(id)
        switch id {
        case 0: return ([1, 2], true)
        case 1:
          let children = computerInspectChildren(
            role: "AXTable", children: rows + [column], rowItems: { items })
          return (children, true)
        // Like the helper, rows outside the window are visited but not emitted.
        default: return ([], id < 1020)
        }
      }
      return (visited, truncated)
    }
    let pruned = walk(
      items: ComputerSecureAuditRowItems(
        all: rows, visible: Array(rows.prefix(20)), others: [column]))
    XCTAssertFalse(pruned.truncated)
    XCTAssertTrue(pruned.visited.contains(2))
    XCTAssertTrue(pruned.visited.contains(column))
    XCTAssertEqual(pruned.visited.count, 24)
    // Without a visible-row report the off-screen rows spend the visited cap first.
    let full = walk(items: nil)
    XCTAssertTrue(full.truncated)
    XCTAssertFalse(full.visited.contains(2))
    let empty = walk(items: ComputerSecureAuditRowItems(all: rows, visible: [], others: [column]))
    XCTAssertTrue(empty.truncated)
  }
  func testInspectChildrenKeepsSmallAndNonRowContainersWhole() {
    let items = ComputerSecureAuditRowItems(all: [1, 2], visible: [1], others: [Int]())
    let many = Array(0..<300)
    XCTAssertEqual(
      computerInspectChildren(role: "AXTable", children: [1, 2], rowItems: { items }), [1, 2])
    XCTAssertEqual(
      computerInspectChildren(role: "AXGroup", children: many, rowItems: { items }), many)
    XCTAssertEqual(
      computerInspectChildren(role: "AXList", children: many, rowItems: { items }), [1])
  }
  func testEmittedAndVisitedCapsAreSoftAndReportTruncation() {
    var visits = 0
    XCTAssertTrue(
      computerInspectWalk(root: 0, maxNodes: 1000, stop: { false }) { id in
        visits += 1
        return ([id + 1], true)
      })
    XCTAssertEqual(visits, 800)
    visits = 0
    XCTAssertTrue(
      computerInspectWalk(root: 0, maxNodes: 400, stop: { false }) { id in
        visits += 1
        return ([id + 1], false)
      })
    XCTAssertEqual(visits, 4000)
  }
  func testTimeStopReturnsPartialButRequestDeadlineStillThrows() {
    var visits = 0
    XCTAssertTrue(
      computerInspectWalk(root: 0, maxNodes: 400, stop: { visits >= 3 }) { id in
        visits += 1
        return ([id + 1], true)
      })
    XCTAssertEqual(visits, 3)
    enum Deadline: Error { case expired }
    XCTAssertThrowsError(
      try computerInspectWalk(
        root: 0, maxNodes: 400,
        stop: {
          throw Deadline.expired
        },
        visit: { _ in
          XCTFail("Must not read after request deadline")
          return ([], false)
        }))
  }
}
