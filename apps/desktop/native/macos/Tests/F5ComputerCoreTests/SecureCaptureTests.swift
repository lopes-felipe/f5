import CoreGraphics
import XCTest

@testable import F5ComputerCore

final class SecureCaptureTests: XCTestCase {
  func testBackgroundAndSecondWindowsAreAuditedWithoutForegroundState() {
    let windows = [
      CGRect(x: 0, y: 0, width: 100, height: 100), CGRect(x: -100, y: 0, width: 100, height: 100),
      CGRect(x: 0, y: 100, width: 100, height: 100),
    ]
    let passwords = windows.map { CGRect(x: $0.minX + 10, y: $0.minY + 10, width: 20, height: 10) }
    var scanned: [Int] = []
    let result = computerSecureCaptureMasks(windows: windows) { index in
      scanned.append(index)
      return ComputerSecureAudit(rects: [passwords[index]], complete: true)
    }
    XCTAssertEqual(scanned, [0, 1, 2])
    XCTAssertEqual(result.rects, passwords)
    XCTAssertFalse(result.incomplete)
  }
  func testMissingOrInvalidAuditMasksOnlyThatWholeWindow() {
    let windows = [
      CGRect(x: 0, y: 0, width: 100, height: 100), CGRect(x: -100, y: 0, width: 100, height: 100),
    ]
    let result = computerSecureCaptureMasks(windows: windows) {
      $0 == 0 ? ComputerSecureAudit(rects: [], complete: true) : nil
    }
    XCTAssertEqual(result.rects, [windows[1]])
    XCTAssertTrue(result.incomplete)
    let invalid = computerSecureCaptureMasks(windows: windows) { _ in
      ComputerSecureAudit(rects: [.null], complete: true)
    }
    XCTAssertEqual(invalid.rects, windows)
    XCTAssertTrue(invalid.incomplete)
  }
  func testPartialAuditMasksOnlyItsRegionsAndReportsIncomplete() {
    let windows = [CGRect(x: 0, y: 0, width: 100, height: 100)]
    let unaudited = CGRect(x: 10, y: 60, width: 30, height: 20)
    let result = computerSecureCaptureMasks(windows: windows) { _ in
      ComputerSecureAudit(rects: [unaudited], complete: false)
    }
    XCTAssertEqual(result.rects, [unaudited])
    XCTAssertTrue(result.incomplete)
  }
  func testMasksAreClippedToTheirWindow() {
    let windows = [
      CGRect(x: 0, y: 0, width: 100, height: 100), CGRect(x: 200, y: 0, width: 100, height: 100),
    ]
    let result = computerSecureCaptureMasks(windows: windows) { index in
      index == 0
        ? ComputerSecureAudit(
          rects: [CGRect(x: 50, y: 50, width: 400, height: 400)], complete: false)
        : ComputerSecureAudit(rects: [CGRect(x: 0, y: 0, width: 10, height: 10)], complete: true)
    }
    XCTAssertEqual(result.rects, [CGRect(x: 50, y: 50, width: 50, height: 50)])
    XCTAssertTrue(result.incomplete)
  }
}

final class CaptureMaskSummaryTests: XCTestCase {
  func testSeverityAndReasonUnion() {
    let outcomes = [
      ComputerCaptureMaskOutcome(.fields),
      ComputerCaptureMaskOutcome(.webArea, reasons: [.partialAudit]),
      ComputerCaptureMaskOutcome(.window, reasons: [.windowMatch, .auditIncomplete]),
      ComputerCaptureMaskOutcome(.window, reasons: [.windowsChanged, .partialAudit]),
    ]
    XCTAssertEqual(computerCaptureMaskSummary([]).masked, "none")
    XCTAssertEqual(computerCaptureMaskSummary(Array(outcomes.prefix(1))).masked, "fields")
    XCTAssertEqual(computerCaptureMaskSummary(Array(outcomes.prefix(2))).masked, "web-area")
    let result = computerCaptureMaskSummary(outcomes)
    XCTAssertEqual(result.masked, "window")
    XCTAssertEqual(
      result.maskReasons, ["audit-incomplete", "partial-audit", "window-match", "windows-changed"])
  }
}
