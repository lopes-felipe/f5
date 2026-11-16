import CoreGraphics

/// Shareable-content metadata only; no desktop pixel read or window titles.
public func computerCaptureWindowIntersectsDisplay(window: CGRect, display: CGRect) -> Bool {
  guard !window.isEmpty, !display.isEmpty else { return false }
  return !window.intersection(display).isEmpty
}

/// Each captured window needs its own audit, regardless of the foreground app.
/// A missing or invalid audit hides that entire window; a partial audit hides only the
/// regions it could not establish as safe. A window's content cannot render outside its
/// frame, so masks are clipped to it and never cover other granted windows.
public func computerSecureCaptureMasks(
  windows: [CGRect], audit: (Int) -> ComputerSecureAudit?
) -> (rects: [CGRect], incomplete: Bool) {
  var masks: [CGRect] = []
  var incomplete = false
  for (index, window) in windows.enumerated() {
    guard let result = audit(index), result.rects.allSatisfy(computerSecureAuditRectIsValid)
    else {
      masks.append(window)
      incomplete = true
      continue
    }
    masks.append(
      contentsOf: result.rects.map { $0.intersection(window) }.filter { !$0.isNull && !$0.isEmpty })
    if !result.complete { incomplete = true }
  }
  return (masks, incomplete)
}

public enum ComputerCaptureMask: String, CaseIterable {
  case none, fields
  case webArea = "web-area"
  case window
}
public enum ComputerCaptureMaskReason: String, Hashable {
  case windowMatch = "window-match"
  case auditIncomplete = "audit-incomplete"
  case partialAudit = "partial-audit"
  case windowsChanged = "windows-changed"
}
public struct ComputerCaptureMaskOutcome {
  public var masked: ComputerCaptureMask
  public var reasons: Set<ComputerCaptureMaskReason>
  public init(_ masked: ComputerCaptureMask, reasons: Set<ComputerCaptureMaskReason> = []) {
    self.masked = masked
    self.reasons = reasons
  }
}
/// Capture metadata is independent of rendering, with deterministic reason ordering.
public func computerCaptureMaskSummary(_ outcomes: [ComputerCaptureMaskOutcome])
  -> (masked: String, maskReasons: [String])
{
  let order = ComputerCaptureMask.allCases
  let severity = outcomes.map { order.firstIndex(of: $0.masked)! }.max() ?? 0
  let reasons = outcomes.reduce(into: Set<ComputerCaptureMaskReason>()) { $0.formUnion($1.reasons) }
  return (order[severity].rawValue, reasons.map(\.rawValue).sorted())
}
