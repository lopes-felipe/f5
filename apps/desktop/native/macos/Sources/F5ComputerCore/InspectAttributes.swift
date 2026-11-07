import ApplicationServices
import CoreGraphics

/// Never batch values: secure detection must precede reading a value.
public let computerInspectAttributes = [
  kAXChildrenAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXRoleAttribute,
  kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXFocusedAttribute,
  kAXEnabledAttribute,
] as CFArray

/// Non-value AX attributes used by inspection, with unavailable fields omitted.
public struct ComputerInspectNodeAttributes {
  public let children: [AXUIElement]
  public let frame: CGRect?
  public let role: String?
  public let subrole: String?
  public let title: String?
  public let description: String?
  public let focused: Bool?
  public let enabled: Bool?
}

/// Fall back to individual reads only when the whole batch fails or has the wrong size.
/// Embedded per-attribute errors stay absent rather than causing more IPC calls.
public func computerInspectReadAttributes(
  batch: () -> (AXError, [AnyObject]?), single: (String) -> AnyObject?
) -> ComputerInspectNodeAttributes {
  let (status, values) = batch()
  let names = computerInspectAttributes as! [String]
  let fields: [AnyObject?]
  if status == .success, let values, values.count == names.count {
    fields = values.map { computerAXBatchError($0) == nil ? $0 : nil }
  } else {
    fields = names.map(single)
  }
  let frame = fields[1].flatMap { computerAXValue($0, .cgPoint, CGPoint.zero) }.flatMap { point in
    fields[2].flatMap { computerAXValue($0, .cgSize, CGSize.zero) }.map {
      CGRect(origin: point, size: $0)
    }
  }
  return ComputerInspectNodeAttributes(
    children: fields[0] as? [AXUIElement] ?? [], frame: frame,
    role: fields[3] as? String, subrole: fields[4] as? String,
    title: fields[5] as? String, description: fields[6] as? String,
    focused: fields[7] as? Bool, enabled: fields[8] as? Bool)
}
