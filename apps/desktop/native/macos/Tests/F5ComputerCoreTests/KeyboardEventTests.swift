import CoreGraphics
import XCTest

@testable import F5ComputerCore

final class KeyboardEventTests: XCTestCase {
  func testNewFunctionKeysCannotReachSystemUI() throws {
    for raw in [
      "Ctrl+F1", "Control+F2", "CTRL+F3", "Ctrl+F8", "Cmd+F5", "Option+Command+F5", "F11",
      "Shift+F11", "Meta+F12",
    ] {
      let chord = try XCTUnwrap(computerKeyChord(raw))
      XCTAssertTrue(
        blockedComputerChord(
          key: chord.key, command: chord.flags.contains(.maskCommand),
          control: chord.flags.contains(.maskControl), alt: chord.flags.contains(.maskAlternate),
          shift: chord.flags.contains(.maskShift)), raw)
    }
    for raw in [
      "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F12", "Meta+Minus", "cmd+=",
      "Down",
    ] {
      let chord = try XCTUnwrap(computerKeyChord(raw))
      XCTAssertFalse(
        blockedComputerChord(
          key: chord.key, command: chord.flags.contains(.maskCommand),
          control: chord.flags.contains(.maskControl), alt: chord.flags.contains(.maskAlternate),
          shift: chord.flags.contains(.maskShift)), raw)
    }
  }
  func testKeyNamesAndAliases() throws {
    let names: [(String, CGKeyCode)] = [
      ("up|arrowup", 126), ("down|arrowdown", 125), ("left|arrowleft", 123),
      ("right|arrowright", 124),
      ("minus|-", 27), ("equal|=|plus", 24), ("bracketleft|[", 33), ("bracketright|]", 30),
      ("semicolon|;", 41), ("quote|'", 39), ("comma|,", 43), ("period|.", 47),
      ("slash|/", 44), ("backslash|\\", 42), ("backquote|`", 50),
    ]
    for (aliases, code) in names {
      for name in aliases.split(separator: "|") {
        XCTAssertEqual(computerKeyChord(String(name).uppercased())?.code, code)
      }
    }
    for (index, code) in [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111].enumerated() {
      XCTAssertEqual(computerKeyChord("F\(index + 1)")?.code, CGKeyCode(code))
    }
    XCTAssertEqual(computerKeyChord("Meta+Minus")?.flags, .maskCommand)
    XCTAssertEqual(computerKeyChord("cmd+=")?.code, 24)
    XCTAssertEqual(computerKeyChord("Down")?.key, "arrowdown")
    XCTAssertEqual(computerKeyChord("esc")?.key, "escape")
    XCTAssertEqual(computerKeyChord("escape")?.key, "escape")
    for invalid in ["", "f13", "hyper+a", "Meta+", "Meta++a", "unknown"] {
      XCTAssertNil(computerKeyChord(invalid))
    }
  }
  func testChordDownCarriesModifiersAndUpClearsThem() throws {
    let modifiers: CGEventFlags = [.maskCommand, .maskShift]
    let down = try XCTUnwrap(computerKeyboardEvent(keyCode: 1, keyDown: true, modifiers: modifiers))
    let up = try XCTUnwrap(computerKeyboardEvent(keyCode: 1, keyDown: false, modifiers: modifiers))
    XCTAssertEqual(down.flags, modifiers)
    XCTAssertTrue(up.flags.isEmpty)
    XCTAssertEqual(down.getIntegerValueField(.keyboardEventKeycode), 1)
    XCTAssertEqual(up.type, .keyUp)
    XCTAssertEqual(up.getIntegerValueField(.eventSourceUserData), 0xF5C0)
  }
  func testUnicodeAndCancellationNeverCarryChordModifiers() throws {
    let units = Array("Ω🙂".utf16)
    for keyDown in [true, false] {
      let event = try XCTUnwrap(
        computerKeyboardEvent(
          keyCode: 0, keyDown: keyDown, modifiers: .maskCommand, unicode: units))
      XCTAssertTrue(event.flags.isEmpty)
      var actual = 0
      var restored = [UniChar](repeating: 0, count: units.count)
      restored.withUnsafeMutableBufferPointer {
        event.keyboardGetUnicodeString(
          maxStringLength: units.count, actualStringLength: &actual, unicodeString: $0.baseAddress)
      }
      XCTAssertEqual(actual, units.count)
      XCTAssertEqual(restored, units)
      XCTAssertEqual(event.getIntegerValueField(.eventSourceUserData), 0xF5C0)
    }
    let release = try XCTUnwrap(computerKeyboardEvent(keyCode: 0, keyDown: false))
    XCTAssertTrue(release.flags.isEmpty)
  }
}
