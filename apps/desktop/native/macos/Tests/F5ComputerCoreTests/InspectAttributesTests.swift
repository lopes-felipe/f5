import ApplicationServices
import XCTest
@testable import F5ComputerCore

final class InspectAttributesTests: XCTestCase {
  func testBatchMatchesFallbackWithoutReadingValues() {
    var point = CGPoint(x: 10, y: 20)
    var size = CGSize(width: 30, height: 40)
    let values: [AnyObject] = [
      [] as NSArray, AXValueCreate(.cgPoint, &point)!, AXValueCreate(.cgSize, &size)!,
      "AXTextField" as NSString, "AXSecureTextField" as NSString, "Title" as NSString,
      "Description" as NSString, true as NSNumber, false as NSNumber,
    ]
    let names = computerInspectAttributes as! [String]
    XCTAssertFalse(names.contains(kAXValueAttribute))
    func check(_ status: AXError, _ batch: [AnyObject]?, fallback: Bool) {
      var reads = 0
      let attributes = computerInspectReadAttributes(batch: { (status, batch) }, single: {
        reads += 1
        return values[names.firstIndex(of: $0)!]
      })
      XCTAssertEqual(reads, fallback ? 9 : 0)
      XCTAssertEqual(attributes.frame, CGRect(x: 10, y: 20, width: 30, height: 40))
      XCTAssertEqual(attributes.role, "AXTextField")
      XCTAssertEqual(attributes.subrole, "AXSecureTextField")
      XCTAssertEqual(attributes.title, "Title")
      XCTAssertEqual(attributes.focused, true)
      XCTAssertEqual(attributes.enabled, false)
    }
    check(.success, values, fallback: false)
    check(.success, Array(values.dropLast()), fallback: true)
    check(.notImplemented, nil, fallback: true)
    for status in [AXError.attributeUnsupported, .noValue] {
      var error = status
      var missing = values
      missing[5] = AXValueCreate(.axError, &error)!
      let result = computerInspectReadAttributes(batch: { (.success, missing) }, single: { _ in
        XCTFail("Missing optional values must not trigger fallback")
        return nil
      })
      XCTAssertNil(result.title)
      XCTAssertEqual(result.description, "Description")
    }
  }
}
