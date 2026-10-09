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
