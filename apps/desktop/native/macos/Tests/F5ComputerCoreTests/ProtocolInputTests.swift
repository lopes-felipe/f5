import Darwin
import Foundation
import XCTest

@testable import F5ComputerCore

final class ProtocolInputTests: XCTestCase {
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
