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
  ((key == "escape" || key == "esc") && command && (alt || control))
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
public func computerMenuPointAllowed(x: Double, left: Double, lastItemRight: Double) -> Bool {
  left.isFinite && lastItemRight.isFinite && x.isFinite && lastItemRight > left && x >= left
    && x < lastItemRight
}
