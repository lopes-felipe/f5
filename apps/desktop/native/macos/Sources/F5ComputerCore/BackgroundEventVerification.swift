/// A changed selection alone cannot prove Shift was delivered: Left without Shift also changes it.
/// The rehearsal starts at a collapsed caret and requires exactly one character selected to its left.
public func computerSelectionExtendedLeft(
  beforeStart: Int, beforeLength: Int, afterStart: Int, afterLength: Int
) -> Bool {
  beforeStart > 0 && beforeLength == 0 && afterStart == beforeStart - 1 && afterLength == 1
}
