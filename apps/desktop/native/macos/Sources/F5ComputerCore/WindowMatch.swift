import CoreGraphics

/// An available AX window ID is authoritative. Frame fallback applies only to candidates
/// without an ID, and minimized windows can never own captured pixels.
public func computerMatchAXWindow<Handle>(
  windows: [Handle], windowID: CGWindowID, frame: CGRect,
  id: (Handle) -> CGWindowID?, rect: (Handle) -> CGRect?, minimized: (Handle) -> Bool
) -> Handle? {
  let candidates = windows.filter { !minimized($0) }
  let identified = candidates.map { ($0, id($0)) }
  let matches = identified.filter { $0.1 == windowID }
  if !matches.isEmpty { return matches.count == 1 ? matches[0].0 : nil }
  let fallback = identified.filter { element, identifier in
    guard identifier == nil, let other = rect(element) else { return false }
    return abs(other.minX - frame.minX) < 1 && abs(other.minY - frame.minY) < 1
      && abs(other.width - frame.width) < 1 && abs(other.height - frame.height) < 1
  }
  return fallback.count == 1 ? fallback[0].0 : nil
}
