import Foundation
import ScreenCaptureKit
import XCTest
@testable import F5ComputerCore

final class CaptureFailureTests: XCTestCase {
  func testScreenCaptureErrorKeepsOnlyStageDomainAndCode() throws {
    let native = NSError(domain: SCStreamErrorDomain, code: -3801,
      userInfo: [NSLocalizedDescriptionKey: "PRIVATE_SENTINEL", "windowTitle": "PRIVATE_SENTINEL"])
    let result = computerCaptureFailureDiagnostic(stage: .imageCapture, error: native)
    XCTAssertEqual(result["stage"] as? String, "image-capture")
    XCTAssertEqual(result["domain"] as? String, "screen-capture-kit")
    XCTAssertEqual(result["code"] as? Int, -3801)
    XCTAssertEqual(result.count, 3)
    let encoded = try JSONSerialization.data(withJSONObject: result)
    XCTAssertFalse(String(data: encoded, encoding: .utf8)!.contains("PRIVATE_SENTINEL"))
  }
  func testUnknownDomainNeverLeavesNativeProcess() {
    let result = computerCaptureFailureDiagnostic(stage: .shareableContent,
      error: NSError(domain: "PRIVATE_SENTINEL", code: 42))
    XCTAssertEqual(result["domain"] as? String, "other")
    XCTAssertEqual(result["code"] as? Int, 42)
    XCTAssertEqual(result["stage"] as? String, "shareable-content")
  }
  func testPermissionPreflightHasNoInventedNativeError() {
    let result = computerCaptureFailureDiagnostic(stage: .permissionPreflight)
    XCTAssertEqual(result["stage"] as? String, "permission-preflight")
    XCTAssertEqual(result.count, 1)
  }
}
