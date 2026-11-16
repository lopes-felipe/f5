import Darwin
import Foundation
import XCTest

@testable import F5ComputerCore

final class ProtocolInputTests: XCTestCase {
  func testOversizedResponseReturnsCorrelatedErrorWithoutRestart() throws {
    let packet: [String: Any] = [
      "type": "response", "requestId": "r", "result": ["data": String(repeating: "é", count: 256)],
    ]
    let bytes = try XCTUnwrap(encodeComputerPacket(packet, maximumSize: 128))
    let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    XCTAssertEqual(parsed["requestId"] as? String, "r")
    XCTAssertEqual((parsed["error"] as? [String: String])?["_tag"], "ResultTooLarge")
    XCTAssertLessThanOrEqual(bytes.count, 128)
    XCTAssertNil(
      encodeComputerPacket(
        ["type": "status", "data": String(repeating: "x", count: 256)], maximumSize: 128))
  }
  func testShortControlCommandArrivesBeforePipeCloses() throws {
    var descriptors: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&descriptors), 0)
    defer {
      close(descriptors[0])
      close(descriptors[1])
    }
    let command = Data("{\"type\":\"suspend\"}\n".utf8)
    XCTAssertEqual(
      command.withUnsafeBytes { Darwin.write(descriptors[1], $0.baseAddress, command.count) },
      command.count)
    let delivered = expectation(description: "Short command delivered while stdin remains open")
    let input = descriptors[0]
    DispatchQueue.global().async {
      do { XCTAssertEqual(try readComputerInputChunk(input), command) } catch {
        XCTFail("Input read failed: \(error)")
      }
      delivered.fulfill()
    }
    wait(for: [delivered], timeout: 1)
  }

  func testEndOfInputAndInvalidDescriptor() throws {
    var descriptors: [Int32] = [0, 0]
    XCTAssertEqual(pipe(&descriptors), 0)
    defer { close(descriptors[0]) }
    close(descriptors[1])
    XCTAssertNil(try readComputerInputChunk(descriptors[0]))
    XCTAssertThrowsError(try readComputerInputChunk(-1))
  }
}
