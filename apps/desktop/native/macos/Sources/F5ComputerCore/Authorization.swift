import CoreGraphics
import Foundation

public func allowsComputerGrant(tier: String, allowTyping: Bool, needed: String) -> Bool {
  guard ["view", "click", "full"].contains(tier) else { return false }
  if needed == "view" { return true }
  if tier == "view" { return false }
  return needed == "click" || (needed == "type" && (tier == "full" || allowTyping))
}
public func blockedComputerChord(key: String, command: Bool, control: Bool, alt: Bool, shift: Bool)
  -> Bool
{
  // Function keys can target system UI without changing the frontmost app. Keep
  // modified F-keys and the Show Desktop shortcut outside app-scoped input.
  let functionKey =
    Int(key.dropFirst()).map { key.hasPrefix("f") && (1...12).contains($0) } ?? false
  return (functionKey && (command || control || alt || shift || key == "f11"))
    || ((key == "escape" || key == "esc") && command && (alt || control))
    || (key == "q" && command && (control || shift)) || (key == "space" && command)
}

private let tierTable =
  try! JSONSerialization.jsonObject(with: Data(computerTierTableJSON.utf8)) as! [String: Any]
private func patternMatches(_ id: String, _ pattern: String) -> Bool {
  let p = pattern.lowercased()
  let id = id.lowercased()
  return p.hasSuffix("*") ? id.hasPrefix(String(p.dropLast())) : id == p
}
public func computerAppTier(_ id: String) -> String {
  let tiers = (tierTable["tiers"] as! [String: Any])["darwin"] as! [String: [String]]
  for candidate in ["blocked", "view", "click"] {
    if tiers[candidate]!.contains(where: { patternMatches(id, $0) }) { return candidate }
  }
  return "full"
}
/// Apps the delivery spike found need the foreground; generated from the canonical policy.
public func computerBackgroundForegroundOnly(_ id: String) -> Bool {
  let background = tierTable["background"] as? [String: Any]
  return (background?["foregroundOnly"] as? [String] ?? []).contains(where: {
    patternMatches(id, $0)
  })
}
public func computerBackgroundEventAppAllowed(_ id: String) -> Bool {
  let events = tierTable["backgroundEvents"] as? [String: [String]]
  #if DEBUG
  let candidates = tierTable["backgroundEventCandidates"] as? [String: [String]]
  if CommandLine.arguments.contains("--rehearse-background-events=" + id) &&
    (candidates?["darwin"] ?? []).contains(id) { return true }
  #endif
  return (events?["darwin"] ?? []).contains { $0.lowercased() == id.lowercased() }
}
public func computerBackgroundKeyAllowed(_ raw: String) -> Bool {
  guard let chord = computerKeyChord(raw) else { return false }
  let key = chord.key
  let command = chord.flags.contains(.maskCommand)
  let control = chord.flags.contains(.maskControl)
  let alt = chord.flags.contains(.maskAlternate)
  let shift = chord.flags.contains(.maskShift)
  return !blockedComputerChord(key: key, command: command, control: control, alt: alt, shift: shift)
    && !(command && ["tab", "space"].contains(key))
    && !(control && ["up", "down", "left", "right", "arrowup", "arrowdown", "arrowleft", "arrowright"].contains(key))
    && !(command && shift && ["3", "4", "5"].contains(key))
}
public func computerAppIsBrowser(_ id: String) -> Bool {
  ((tierTable["browsers"] as! [String: [String]])["darwin"]!).contains(where: {
    patternMatches(id, $0)
  })
}

/// OS-facing adapters gather identity/focus facts; this policy is shared with tests.
public func computerTargetBlock(appId: String?, pid: Int, f5Pids: [Int], helperPid: Int) -> String?
{
  if f5Pids.contains(pid) || pid == helperPid { return "f5" }
  guard let appId, !appId.isEmpty else { return "owner-unknown" }
  if [
    "com.apple.dock", "com.apple.controlcenter", "com.apple.notificationcenterui",
    "com.apple.spotlight",
  ].contains(appId.lowercased()) {
    return "system-ui"
  }
  return computerAppTier(appId) == "blocked" ? "protection-unknown" : nil
}
public func computerFocusBlock(
  frontPid: Int, focusedPid: Int?, secureInput: Bool, role: String?, subrole: String?
) -> String? {
  guard let focusedPid, focusedPid == frontPid else { return "owner-unknown" }
  guard let role else { return "focus-unknown" }
  return secureInput || role == "AXSecureTextField" || subrole == "AXSecureTextField"
    ? "secure-field" : nil
}
public func computerFocusUnchanged(
  initialPid: Int, currentPid: Int, sameWindow: Bool, sameElement: Bool, typing: Bool
) -> Bool {
  initialPid == currentPid && sameWindow && (!typing || sameElement)
}
public func computerMenuPointAllowed(x: Double, y: Double, items: [CGRect?]) -> Bool {
  guard x.isFinite, y.isFinite, items.count > 1, let apple = items.first!,
    apple.minX.isFinite, apple.minY.isFinite, apple.width.isFinite, apple.height.isFinite,
    apple.width > 0, apple.height > 0,
    !apple.contains(CGPoint(x: x, y: y))
  else { return false }
  // The first child is the system Apple menu, even inside the app's AX menu bar.
  return items.dropFirst().contains { bounds in
    guard let bounds, bounds.minX.isFinite, bounds.minY.isFinite,
      bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0
    else { return false }
    return x >= bounds.minX && x < bounds.maxX && y >= bounds.minY && y < bounds.maxY
  }
}

/// AppKit's mouse-down hit test uses bottom-left global points. Quartz uses
/// top-left global points, relative to the same primary display, including
/// negative origins on secondary displays.
public func computerAppKitCoordinates(x: Double, y: Double, primaryDisplayHeight: Double)
  -> (x: Double, y: Double)
{
  (x: x, y: primaryDisplayHeight - y)
}

/// Resolve the OS-selected recipient by window identity, never by rectangle order.
/// A missing/stale owner is refused rather than substituted with a nearby window.
public func computerRecipientPid(windowId: Int, owners: [Int: Int], overlayWindowIds: [Int]) -> Int?
{
  guard windowId > 0, !overlayWindowIds.contains(windowId), let pid = owners[windowId], pid > 0
  else { return nil }
  return pid
}
