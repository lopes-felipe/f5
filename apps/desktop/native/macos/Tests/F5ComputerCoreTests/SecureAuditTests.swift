import ApplicationServices
import CoreGraphics
import XCTest

@testable import F5ComputerCore

final class SecureAuditTests: XCTestCase {
  typealias Node = ComputerSecureAuditNode<Int>
  final class Reads { var ids: [Int] = [] }
  let window = CGRect(x: 0, y: 0, width: 1000, height: 800)
  let web = CGRect(x: 0, y: 80, width: 1000, height: 720)

  func audit(
    _ tree: [Int: Node], maxDepth: Int = 80, maxNodes: Int = 20000,
    expired: @escaping () -> Bool = { false }, reads: Reads = Reads()
  ) -> ComputerSecureAudit? {
    computerSecureAudit(
      root: 0,
      read: { id in
        reads.ids.append(id)
        return tree[id]
      }, maxDepth: maxDepth, maxNodes: maxNodes, expired: expired)
  }
  func rect(_ x: Double, _ y: Double) -> CGRect { CGRect(x: x, y: y, width: 40, height: 20) }
  /// Window > web area > small wrapper whose secure descendant renders far outside it.
  func escapingTree(wrapper: Node? = nil) -> [Int: Node] {
    [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXWebArea", frame: web, children: [2]),
      2: wrapper ?? Node(role: "AXGroup", frame: rect(10, 90), children: [3]),
      3: Node(role: "AXSecureTextField", frame: CGRect(x: 500, y: 500, width: 100, height: 30)),
    ]
  }

  func testMissingAndConservativeModeWalkButFastAcceptsOmittedFields() {
    XCTAssertEqual(ComputerPasswordMasking.requested(nil), .conservative)
    XCTAssertEqual(ComputerPasswordMasking.requested("unknown"), .conservative)
    let tree = escapingTree()
    var searchCalls = 0
    let omittedPassword: (Int) -> [Int]? = { _ in
      searchCalls += 1
      return []
    }
    for value in [nil, "conservative", "fast"] {
      let mode = ComputerPasswordMasking.requested(value)
      let result = computerSecureAudit(
        root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 20000,
        expired: { false }, search: mode.usesWebAreaSearch ? omittedPassword : nil)
      XCTAssertEqual(
        result,
        ComputerSecureAudit(rects: mode == .fast ? [] : [tree[3]!.frame!], complete: true))
    }
    // Successful search may miss a real field. This explicitly records fast mode's limitation.
    XCTAssertEqual(searchCalls, 1)
  }
  func testNativeChromeDrainsBeforeHugeWebSubtree() {
    var tree = escapingTree()
    tree[0]?.children.append(10)
    for id in 10...20 { tree[id] = Node(role: "AXGroup", frame: rect(0, 0), children: [id + 1]) }
    tree[21] = Node(role: "AXSecureTextField", frame: rect(0, 0))
    let reads = Reads()
    let result = audit(tree, maxNodes: 16, reads: reads)
    XCTAssertNotNil(result)
    XCTAssertTrue(reads.ids.contains(21))
    XCTAssertEqual(result?.complete, false)
    XCTAssertTrue(result?.rects.contains(web) ?? false)
  }
  func testSearchMasksOnlySecureResultsWithoutReadingWebChildren() {
    var tree = escapingTree()
    tree[4] = Node(role: "AXTextField", frame: rect(200, 100))
    var childrenRead: [Int] = []
    let result = computerSecureAudit(
      root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 100,
      expired: { false }, search: { _ in [3, 4] },
      children: { id in
        childrenRead.append(id)
        return tree[id]?.children
      })
    XCTAssertEqual(result, ComputerSecureAudit(rects: [tree[3]!.frame!], complete: true))
    XCTAssertFalse(childrenRead.contains(1))
    XCTAssertEqual(
      computerSecureAudit(
        root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 100,
        expired: { false }, search: { _ in nil }), result)
  }
  func testBadSearchResultsAndSearchBudgetsMaskWebArea() {
    for results in [[99], [3], Array(repeating: 3, count: 5000)] {
      var tree = escapingTree()
      tree[3]?.frame = nil
      let result = computerSecureAudit(
        root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 100,
        expired: { false }, search: { _ in results })
      XCTAssertEqual(result, ComputerSecureAudit(rects: [web], complete: false))
    }
    let tree = escapingTree()
    let result = computerSecureAudit(
      root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 4,
      expired: { false }, search: { _ in [3, 3] })
    XCTAssertEqual(result?.complete, false)
    XCTAssertTrue(result?.rects.contains(web) ?? false)
  }
  func testSearchDeadlineMasksWebAreaEvenWithNoResults() {
    let tree = escapingTree()
    var timedOut = false
    let result = computerSecureAudit(
      root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 20000,
      expired: { timedOut },
      search: { _ in
        timedOut = true
        return []
      })
    XCTAssertEqual(result, ComputerSecureAudit(rects: [web], complete: false))
  }
  func testCompleteTreeMasksOnlyThePasswordField() {
    let password = rect(100, 100)
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXGroup", frame: CGRect(x: 0, y: 50, width: 1000, height: 750), children: [3]),
      2: Node(role: "AXButton", frame: rect(0, 0)),
      3: Node(role: "AXTextField", subrole: "AXSecureTextField", frame: password),
    ]
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [password], complete: true))
  }

  func testBudgetCutoffMasksClippingAncestorNotWrapperFrame() {
    let result = audit(escapingTree(), maxNodes: 3)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [web], complete: false))
  }

  func testDepthCutoffMasksClippingAncestorNotNodeFrame() {
    XCTAssertEqual(
      audit(escapingTree(), maxDepth: 2), ComputerSecureAudit(rects: [web], complete: false))
  }

  func testUnreadableSubtreeMasksClippingAncestorNotNodeFrame() {
    let wrapper = Node(role: "AXGroup", frame: rect(10, 90), childrenReadable: false)
    XCTAssertEqual(
      audit(escapingTree(wrapper: wrapper)), ComputerSecureAudit(rects: [web], complete: false))
    var unreadable = escapingTree()
    unreadable[2] = nil
    XCTAssertEqual(audit(unreadable), ComputerSecureAudit(rects: [web], complete: false))
  }

  func testCutoffWithoutClippingAncestorMasksWholeWindow() {
    var tree = escapingTree()
    tree[1] = Node(role: "AXGroup", frame: web, children: [2])
    XCTAssertNil(audit(tree, maxNodes: 3))
    XCTAssertNil(audit(tree, maxDepth: 2))
  }

  func testExpiredDeadlineMasksLikeBudget() {
    var checks = 0
    let result = audit(
      escapingTree(),
      expired: {
        checks += 1
        return checks > 3
      })
    XCTAssertEqual(result, ComputerSecureAudit(rects: [web], complete: false))
  }

  func testShallowSecureFieldStaysExactWhileDeepSiblingExhaustsBudget() {
    let password = rect(100, 100)
    let list = CGRect(x: 500, y: 100, width: 400, height: 600)
    var tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXWebArea", frame: web, children: [2, 3]),
      2: Node(role: "AXSecureTextField", frame: password),
      3: Node(role: "AXScrollArea", frame: list, children: [4]),
    ]
    for depth in 4...40 {
      tree[depth] = Node(role: "AXGroup", frame: rect(600, 200), children: [depth + 1])
    }
    let result = audit(tree, maxNodes: 8)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [password, list], complete: false))
  }

  func testPendingFrontierWithAnyEntryOutsideAClipMasksWholeWindow() {
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXWebArea", frame: web, children: [3]),
      2: Node(role: "AXGroup", frame: rect(0, 0), children: [4]),
      3: Node(role: "AXButton", frame: rect(100, 100)),
      4: Node(role: "AXButton", frame: rect(0, 0)),
    ]
    XCTAssertNil(audit(tree, maxNodes: 3))
  }

  func testUnreadableRootMasksWholeWindow() {
    XCTAssertNil(audit([:]))
    XCTAssertNil(audit([0: Node(role: "AXWindow", frame: window, childrenReadable: false)]))
  }

  func testTextAndImageSubtreesAreNotVisited() {
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXStaticText", frame: rect(0, 0), children: [3]),
      2: Node(role: "AXImage", frame: rect(50, 0), children: [4]),
      3: Node(role: "AXInlineTextBox", frame: rect(0, 0)),
      4: Node(role: "AXGroup", frame: rect(50, 0)),
    ]
    let reads = Reads()
    XCTAssertEqual(audit(tree, reads: reads), ComputerSecureAudit(rects: [], complete: true))
    XCTAssertEqual(reads.ids, [0, 1, 2])
  }

  func testSecureFieldWithoutUsableFrameIsIncomplete() {
    let invalid = Node(
      role: "AXSecureTextField", frame: CGRect(x: 0, y: 0, width: Double.infinity, height: 10))
    var tree = escapingTree()
    tree[3] = invalid
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [web], complete: false))
    tree[1] = Node(role: "AXGroup", frame: web, children: [2])
    XCTAssertNil(audit(tree))
  }

  func testMasksAlreadyCoveredAreSkipped() {
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXWebArea", frame: web, children: [2, 3]),
      2: Node(role: "AXGroup", frame: rect(10, 90), childrenReadable: false),
      3: Node(role: "AXSecureTextField", frame: rect(100, 100)),
    ]
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [web], complete: false))
  }

  func testDeadlineSplitsRemainingBudgetAcrossWindowsLeft() {
    XCTAssertEqual(computerSecureAuditDeadline(now: 10, end: 12, windowsLeft: 2), 11)
    XCTAssertEqual(computerSecureAuditDeadline(now: 11.5, end: 12, windowsLeft: 1), 12)
    XCTAssertEqual(computerSecureAuditDeadline(now: 13, end: 12, windowsLeft: 1), 13)
    XCTAssertEqual(computerSecureAuditDeadline(now: 10, end: 12, windowsLeft: 0), 12)
  }

  func testBatchedValuesParseFrameAndChildErrors() throws {
    func error(_ code: AXError) -> AnyObject {
      var code = code
      return AXValueCreate(.axError, &code)!
    }
    var point = CGPoint(x: 10, y: 20)
    var size = CGSize(width: 30, height: 40)
    let position = AXValueCreate(.cgPoint, &point)!
    let dimensions = AXValueCreate(.cgSize, &size)!
    let failed = try XCTUnwrap(
      computerSecureAuditNode(
        ["AXGroup" as NSString, error(.noValue), position, dimensions, error(.cannotComplete)]))
    XCTAssertEqual(failed.role, "AXGroup")
    XCTAssertNil(failed.subrole)
    XCTAssertEqual(failed.frame, CGRect(x: 10, y: 20, width: 30, height: 40))
    XCTAssertFalse(failed.childrenReadable)
    XCTAssertTrue(failed.children.isEmpty)
    let leaf = try XCTUnwrap(
      computerSecureAuditNode(
        [
          error(.cannotComplete), "AXSecureTextField" as NSString, error(.noValue), dimensions,
          error(.attributeUnsupported),
        ]))
    XCTAssertNil(leaf.role)
    XCTAssertEqual(leaf.subrole, "AXSecureTextField")
    XCTAssertNil(leaf.frame)
    XCTAssertTrue(leaf.childrenReadable)
    let parent = try XCTUnwrap(
      computerSecureAuditNode(
        [
          "AXGroup" as NSString, error(.noValue), position, dimensions,
          [AXUIElementCreateApplication(getpid())] as NSArray,
        ]))
    XCTAssertEqual(parent.children.count, 1)
    XCTAssertTrue(parent.childrenReadable)
    XCTAssertTrue(parent.subroleReadable)
    let field = try XCTUnwrap(
      computerSecureAuditNode(
        ["AXTextField" as NSString, error(.cannotComplete), position, dimensions, [] as NSArray]))
    XCTAssertEqual(field.role, "AXTextField")
    XCTAssertNil(field.subrole)
    XCTAssertFalse(field.subroleReadable)
    XCTAssertTrue(field.mayBeSecureField)
    let chrome = try XCTUnwrap(
      computerSecureAuditNode(
        ["AXGroup" as NSString, error(.failure), position, dimensions, [] as NSArray]))
    XCTAssertFalse(chrome.subroleReadable)
    XCTAssertFalse(chrome.mayBeSecureField)
    XCTAssertEqual(chrome.frame, CGRect(x: 10, y: 20, width: 30, height: 40))
    XCTAssertNil(computerSecureAuditNode(["AXGroup" as NSString]))
  }

  /// Window > toolbar > native chrome whose subrole read fails, as Preview's windows do.
  func unreadableSubroleTree(_ element: Node) -> [Int: Node] {
    [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXToolbar", frame: rect(0, 0), children: [3, 4]),
      2: Node(role: "AXSplitGroup", frame: web, children: [5]),
      3: element,
      4: Node(role: "AXButton", frame: rect(50, 0)),
      5: Node(role: "AXScrollArea", frame: web, children: [6]),
      6: Node(role: "AXImage", frame: web),
    ]
  }

  func testUnreadableSubroleOnChildlessChromeMasksOnlyThatElement() {
    let element = rect(10, 0)
    let tree = unreadableSubroleTree(
      Node(role: "AXGroup", frame: element, children: [], subroleReadable: false))
    let diagnostics = ComputerSecureAuditDiagnostics()
    let result = computerSecureAudit(
      root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 20000, expired: { false },
      diagnostics: diagnostics)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [element], complete: true))
    XCTAssertEqual(diagnostics.stopReasons, [.unreadableSubrole])
    XCTAssertEqual(diagnostics.visitedNodes, tree.count)
  }

  func testUnreadableSubroleOnContainerStillAuditsItsChildren() {
    let password = CGRect(x: 600, y: 400, width: 100, height: 30)
    var tree = unreadableSubroleTree(
      Node(role: "AXGroup", frame: rect(10, 0), children: [7], subroleReadable: false))
    tree[7] = Node(role: "AXSecureTextField", frame: password)
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [password], complete: true))
  }

  func testSuspectedFieldStillAuditsChildrenOutsideItsFrame() {
    let field = rect(10, 0)
    let password = CGRect(x: 600, y: 400, width: 100, height: 30)
    for role in ["AXComboBox", "AXTextField", "AXTextArea"] {
      var tree = unreadableSubroleTree(
        Node(role: role, frame: field, children: [7], subroleReadable: false))
      tree[7] = Node(role: "AXSecureTextField", frame: password)
      let reads = Reads()
      XCTAssertEqual(
        audit(tree, reads: reads), ComputerSecureAudit(rects: [field, password], complete: true),
        role)
      XCTAssertTrue(reads.ids.contains(7), role)
    }
  }

  func testSuspectedFieldWithUnreadableChildrenMasksItsClippingAncestor() {
    let field = rect(10, 100)
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXScrollArea", frame: web, children: [2]),
      2: Node(
        role: "AXComboBox", frame: field, childrenReadable: false, subroleReadable: false),
    ]
    let result = audit(tree)
    XCTAssertEqual(result?.complete, false)
    XCTAssertEqual(result?.rects, [field, web])
  }

  func testUnreadableSubroleOnTextFieldMasksOnlyThatField() {
    let field = rect(10, 0)
    let tree = unreadableSubroleTree(
      Node(role: "AXTextField", frame: field, subroleReadable: false))
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [field], complete: true))
    for role in ["AXTextArea", "AXComboBox"] {
      let other = unreadableSubroleTree(Node(role: role, frame: field, subroleReadable: false))
      XCTAssertEqual(audit(other), ComputerSecureAudit(rects: [field], complete: true), role)
    }
  }

  func testUnreadableSubroleOnTextFieldWithoutFrameStillMasksTheWindow() {
    let tree = unreadableSubroleTree(
      Node(role: "AXTextField", frame: nil, subroleReadable: false))
    let diagnostics = ComputerSecureAuditDiagnostics()
    let result = computerSecureAudit(
      root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 20000, expired: { false },
      diagnostics: diagnostics)
    XCTAssertNil(result)
    XCTAssertEqual(diagnostics.stopReasons, [.unreadableSubrole, .secureFieldWithoutFrame])
  }

  func testReadableSecureSubroleIsStillMasked() {
    let field = rect(10, 0)
    let tree = unreadableSubroleTree(
      Node(role: "AXTextField", subrole: "AXSecureTextField", frame: field))
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [field], complete: true))
  }

  func testSearchResultWithUnreadableSubroleMasksSecureCapableFields() {
    var tree = escapingTree()
    let field = rect(200, 100)
    tree[4] = Node(role: "AXTextField", frame: field, subroleReadable: false)
    tree[5] = Node(role: "AXButton", frame: rect(300, 100), subroleReadable: false)
    let result = computerSecureAudit(
      root: 0, read: { tree[$0] }, maxDepth: 256, maxNodes: 100,
      expired: { false }, search: { _ in [3, 4, 5] })
    XCTAssertEqual(result, ComputerSecureAudit(rects: [tree[3]!.frame!, field], complete: true))
  }

  // MARK: Large row containers

  typealias Items = ComputerSecureAuditRowItems<Int>
  let messages = CGRect(x: 0, y: 100, width: 400, height: 600)
  let preview = CGRect(x: 500, y: 100, width: 400, height: 600)
  let previewField = CGRect(x: 600, y: 200, width: 100, height: 30)
  let firstRow = 1000
  let column = 50

  /// Window > [message scroll area > table of 30 pt rows, preview scroll area > group > password].
  /// Rows 0..<20 fill the 600 pt message clip; the rest are scrolled out below it.
  func mailTree(rows: Int = 12000) -> [Int: Node] {
    let rowIds = Array(firstRow..<(firstRow + rows))
    var tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXScrollArea", frame: messages, children: [3]),
      2: Node(role: "AXScrollArea", frame: preview, children: [4]),
      3: Node(
        role: "AXTable",
        frame: CGRect(x: 0, y: 100, width: 400, height: Double(rows) * 30),
        children: rowIds + [column]),
      4: Node(role: "AXGroup", frame: preview, children: [5]),
      5: Node(role: "AXSecureTextField", frame: previewField),
      column: Node(role: "AXColumn", frame: CGRect(x: 0, y: 100, width: 400, height: 600)),
    ]
    for (index, id) in rowIds.enumerated() {
      tree[id] = Node(
        role: "AXRow", frame: CGRect(x: 0, y: 100 + Double(index) * 30, width: 400, height: 30))
    }
    return tree
  }
  func rows(_ range: Range<Int>) -> [Int] { range.map { firstRow + $0 } }
  func mailItems(_ tree: [Int: Node], visible: [Int]? = nil) -> Items {
    let all = tree[3]!.children.filter { $0 != column }
    return Items(all: all, visible: visible ?? rows(0..<20), others: [column])
  }
  func auditRows(
    _ tree: [Int: Node], items: Items?, maxNodes: Int = 20000,
    diagnostics: ComputerSecureAuditDiagnostics = ComputerSecureAuditDiagnostics(),
    reads: Reads = Reads()
  ) -> ComputerSecureAudit? {
    computerSecureAudit(
      root: 0,
      read: { id in
        reads.ids.append(id)
        return tree[id]
      }, maxDepth: 80, maxNodes: maxNodes, expired: { false },
      rowItems: { id, role in
        XCTAssertEqual(id, 3)
        XCTAssertEqual(role, "AXTable")
        return items
      }, diagnostics: diagnostics)
  }

  func testLargeClippedTableAuditsOnlyItsVisibleRows() {
    let tree = mailTree()
    let diagnostics = ComputerSecureAuditDiagnostics()
    let reads = Reads()
    let result = auditRows(
      tree, items: mailItems(tree), maxNodes: 5000, diagnostics: diagnostics, reads: reads)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [previewField], complete: true))
    XCTAssertLessThan(diagnostics.visitedNodes, 100)
    XCTAssertEqual(diagnostics.prunedRows, 11980)
    XCTAssertFalse(reads.ids.contains(firstRow + 500))
    XCTAssertTrue(reads.ids.contains(firstRow + 20), "the row after the visible run is checked")
    // The same budget walking every row is what greyed out Mail: both scroll areas masked.
    XCTAssertEqual(
      audit(tree, maxNodes: 5000), ComputerSecureAudit(rects: [messages, preview], complete: false))
  }

  func testSecureFieldsInVisibleRowsAndNonRowChildrenAreMasked() {
    var tree = mailTree()
    let rowField = CGRect(x: 10, y: 255, width: 100, height: 20)
    let headerField = CGRect(x: 10, y: 102, width: 100, height: 20)
    tree[firstRow + 5]?.children = [70]
    tree[70] = Node(role: "AXTextField", subrole: "AXSecureTextField", frame: rowField)
    tree[column]?.children = [71]
    tree[71] = Node(role: "AXSecureTextField", frame: headerField)
    let result = auditRows(tree, items: mailItems(tree))
    XCTAssertEqual(result?.complete, true)
    XCTAssertEqual(Set(result?.rects ?? []), [previewField, rowField, headerField])
  }

  func testUntrustworthyVisibleRowReportsFallBackToTheFullWalk() {
    var invalidNeighbor = mailTree()
    invalidNeighbor[firstRow + 20]?.frame = nil
    let tree = mailTree()
    let cases: [(String, [Int: Node], Items?)] = [
      ("reader returned nil", tree, nil),
      ("no visible rows", tree, mailItems(tree, visible: [])),
      ("non-contiguous", tree, mailItems(tree, visible: rows(0..<5) + rows(6..<20))),
      ("duplicate", tree, mailItems(tree, visible: rows(0..<20) + [firstRow])),
      ("not an item", tree, mailItems(tree, visible: rows(0..<19) + [column])),
      ("stale: next row is on screen", tree, mailItems(tree, visible: rows(0..<10))),
      ("stale: previous row is on screen", tree, mailItems(tree, visible: rows(1..<20))),
      ("neighbor without a frame", invalidNeighbor, mailItems(invalidNeighbor)),
    ]
    for (name, tree, items) in cases {
      let diagnostics = ComputerSecureAuditDiagnostics()
      let reads = Reads()
      let result = auditRows(tree, items: items, diagnostics: diagnostics, reads: reads)
      XCTAssertEqual(result, ComputerSecureAudit(rects: [previewField], complete: true), name)
      XCTAssertEqual(diagnostics.prunedRows, 0, name)
      XCTAssertTrue(reads.ids.contains(firstRow + 11999), name)
    }
  }

  func testNeighborTouchingTheClipEdgeStillCountsAsOffscreen() {
    var tree = mailTree()
    // Row 20 starts 1 pt inside the clip's bottom edge.
    tree[firstRow + 20]?.frame = CGRect(x: 0, y: 699, width: 400, height: 30)
    let diagnostics = ComputerSecureAuditDiagnostics()
    _ = auditRows(tree, items: mailItems(tree), diagnostics: diagnostics)
    XCTAssertEqual(diagnostics.prunedRows, 11980)
  }

  func testSmallOrUnclippedRowContainersAreWalkedInFull() {
    let small = mailTree(rows: 150)
    let smallReads = Reads()
    _ = auditRows(small, items: mailItems(small), reads: smallReads)
    XCTAssertTrue(smallReads.ids.contains(firstRow + 149))

    var unclipped = mailTree()
    unclipped[0]?.children = [3, 2]
    let diagnostics = ComputerSecureAuditDiagnostics()
    let reads = Reads()
    let result = auditRows(
      unclipped, items: mailItems(unclipped), diagnostics: diagnostics, reads: reads)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [previewField], complete: true))
    XCTAssertEqual(diagnostics.prunedRows, 0)
    XCTAssertTrue(reads.ids.contains(firstRow + 11999))
  }
}
