import XCTest
@testable import F5ComputerCore

private struct Stop: Error, Equatable { let name: String }

/// Records the events one `computerDeliverText` run produces.
private final class Recorder {
  var events: [String] = []
  var focus: [ComputerTypingStop?] = []
  var failDownAt: Int?
  var failPermitAt: Int?
  private var downs = 0
  private var permits = 0

  func run(_ text: String, chunk: Int = 4) async throws -> ComputerTypingOutcome {
    try await computerDeliverText(
      text, chunkCharacters: chunk,
      checkPermit: {
        permits += 1
        if permits == failPermitAt { throw Stop(name: "paused") }
      },
      focusBeforeStart: { events.append("start") },
      focusState: { focus.isEmpty ? nil : focus.removeFirst() },
      postDown: { units in
        downs += 1
        if downs == failDownAt { throw Stop(name: "down") }
        events.append("down:\(String(utf16CodeUnits: units, count: units.count))")
      },
      postUp: { units in events.append("up:\(String(utf16CodeUnits: units, count: units.count))") },
      pause: { events.append("pause") })
  }
}

final class TextDeliveryTests: XCTestCase {
  func testEveryKeydownGetsItsKeyupAndChunksArePaused() async throws {
    let recorder = Recorder()
    let outcome = try await recorder.run("abcdefghij")
    XCTAssertEqual(outcome, .complete)
    XCTAssertEqual(
      recorder.events,
      ["start", "down:abcd", "up:abcd", "pause", "down:efgh", "up:efgh", "pause", "down:ij", "up:ij"])
    XCTAssertNil(outcome.verification)
  }
  func testSingleChunkIsNotCheckedBetweenKeydownAndKeyup() async throws {
    let recorder = Recorder()
    // Focus would read as moved once the chunk landed; that is left to the settle check.
    recorder.focus = [nil, .focusMoved]
    let outcome = try await recorder.run("SingleEnvironmentMultiApps", chunk: 32)
    XCTAssertEqual(outcome, .complete)
    XCTAssertEqual(recorder.focus, [.focusMoved])
  }
  func testFocusMovedBeforeAnythingIsBlocked() async throws {
    let recorder = Recorder()
    recorder.focus = [.focusMoved]
    let outcome = try await recorder.run("abc")
    XCTAssertEqual(outcome, .blocked)
    XCTAssertEqual(recorder.events, ["start"])
  }
  func testFocusMovedAfterAChunkStopsWithUTF16Counts() async throws {
    let recorder = Recorder()
    recorder.focus = [nil, .secureField]
    // The first chunk is four characters but five UTF-16 units: the emoji is a surrogate pair.
    let outcome = try await recorder.run("ab😀cxyz")
    XCTAssertEqual(outcome, .stopped(delivered: 5, requested: 8, reason: .secureField))
    XCTAssertEqual(recorder.events, ["start", "down:ab😀c", "up:ab😀c", "pause"])
    let verification = try XCTUnwrap(outcome.verification)
    XCTAssertEqual(verification["verified"] as? Bool, false)
    XCTAssertEqual(verification["charactersDelivered"] as? Int, 5)
    XCTAssertEqual(verification["charactersRequested"] as? Int, 8)
    XCTAssertEqual(verification["stoppedBy"] as? String, "secure-field")
  }
  func testFailuresPropagateWithoutAKeyupForAnUnpostedChunk() async {
    let recorder = Recorder()
    recorder.failDownAt = 2
    do {
      _ = try await recorder.run("abcdefgh")
      XCTFail("expected the keydown failure")
    } catch { XCTAssertEqual(error as? Stop, Stop(name: "down")) }
    XCTAssertEqual(recorder.events, ["start", "down:abcd", "up:abcd", "pause"])
    let paused = Recorder()
    paused.failPermitAt = 2
    do {
      _ = try await paused.run("abcdefgh")
      XCTFail("expected the permit failure")
    } catch { XCTAssertEqual(error as? Stop, Stop(name: "paused")) }
    XCTAssertEqual(paused.events, ["start", "down:abcd", "up:abcd", "pause"])
  }
  func testFocusFailuresBecomeStopReasons() {
    XCTAssertEqual(computerTypingStop(failure: ["_tag": "NotGranted", "needed": "type"]), .notGranted)
    XCTAssertEqual(
      computerTypingStop(failure: ["_tag": "TargetBlocked", "kind": "secure-field"]), .secureField)
    XCTAssertEqual(
      computerTypingStop(failure: ["_tag": "TargetBlocked", "kind": "other-app"]), .otherApp)
    XCTAssertEqual(
      computerTypingStop(failure: ["_tag": "TargetBlocked", "kind": "protection-unknown"]),
      .focusUnknown)
    XCTAssertEqual(computerTypingStop(failure: ["_tag": "Execution"]), .focusUnknown)
  }
  func testComboboxOptionFocusCountsAsUnchanged() {
    var reads = 0
    func read(_ value: Bool) -> Bool {
      reads += 1
      return value
    }
    XCTAssertTrue(computerTypingFocusUnchanged(
      samePidAndWindow: true, sameElement: true, initialStillFocused: read(false),
      currentEditable: read(false), currentWithinInitial: read(false)))
    XCTAssertEqual(reads, 0)
    XCTAssertFalse(computerTypingFocusUnchanged(
      samePidAndWindow: false, sameElement: true, initialStillFocused: true,
      currentEditable: false, currentWithinInitial: true))
    // The field keeps keyboard focus while AX reports its active option.
    XCTAssertTrue(computerTypingFocusUnchanged(
      samePidAndWindow: true, sameElement: false, initialStillFocused: true,
      currentEditable: false, currentWithinInitial: false))
    // The option lies in the listbox the field controls.
    XCTAssertTrue(computerTypingFocusUnchanged(
      samePidAndWindow: true, sameElement: false, initialStillFocused: false,
      currentEditable: false, currentWithinInitial: true))
    // Another text field took focus, even inside the controlled region.
    XCTAssertFalse(computerTypingFocusUnchanged(
      samePidAndWindow: true, sameElement: false, initialStillFocused: false,
      currentEditable: true, currentWithinInitial: true))
    XCTAssertFalse(computerTypingFocusUnchanged(
      samePidAndWindow: true, sameElement: false, initialStillFocused: false,
      currentEditable: false, currentWithinInitial: false))
    XCTAssertTrue(computerEditableRole("AXTextField"))
    XCTAssertTrue(computerEditableRole(nil))
    XCTAssertFalse(computerEditableRole("AXStaticText"))
  }
}
