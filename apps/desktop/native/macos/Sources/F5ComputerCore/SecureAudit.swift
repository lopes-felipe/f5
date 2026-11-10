import ApplicationServices
import CoreGraphics

/// One accessibility element as the secure-field audit reads it.
/// `childrenReadable` and `subroleReadable` are false only when that read failed with a real
/// error.
public struct ComputerSecureAuditNode<Handle> {
  public var role: String?
  public var subrole: String?
  public var frame: CGRect?
  public var children: [Handle]
  public var childrenReadable: Bool
  public var subroleReadable: Bool
  public init(
    role: String?, subrole: String? = nil, frame: CGRect?, children: [Handle] = [],
    childrenReadable: Bool = true, subroleReadable: Bool = true
  ) {
    self.role = role
    self.subrole = subrole
    self.frame = frame
    self.children = children
    self.childrenReadable = childrenReadable
    self.subroleReadable = subroleReadable
  }
}

/// Roles that can carry the `AXSecureTextField` subrole. When such an element's subrole cannot
/// be read, the audit treats it as a secure field; for any other role the subrole is irrelevant.
let computerSecureAuditSecureCapableRoles: Set<String> = [
  "AXTextField", "AXTextArea", "AXComboBox",
]

extension ComputerSecureAuditNode {
  /// The role or subrole reads as a secure text field.
  var isSecureField: Bool { role == "AXSecureTextField" || subrole == "AXSecureTextField" }
  /// The subrole could not be read and the role can carry the secure subrole.
  var isSuspectedSecureField: Bool {
    guard !subroleReadable, let role else { return false }
    return computerSecureAuditSecureCapableRoles.contains(role)
  }
  /// True when this element is, or cannot be ruled out as, a secure text field.
  var mayBeSecureField: Bool { isSecureField || isSuspectedSecureField }
}

/// Rects to mask in one window: secure fields plus any region the audit could not establish
/// as safe. `complete` is false when any such region was masked. A completed search
/// cannot establish that the app exposed every visually present field to accessibility.
public struct ComputerSecureAudit: Equatable {
  public var rects: [CGRect]
  public var complete: Bool
  public init(rects: [CGRect], complete: Bool) {
    self.rects = rects
    self.complete = complete
  }
}

public func computerSecureAuditRectIsValid(_ rect: CGRect) -> Bool {
  !rect.isEmpty && !rect.isInfinite && !rect.isNull
    && rect.origin.x.isFinite && rect.origin.y.isFinite
    && rect.width.isFinite && rect.height.isFinite
}

/// Attributes the audit reads per element, in the order `computerSecureAuditNode` expects.
public let computerSecureAuditAttributes =
  [
    kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute,
    kAXChildrenAttribute,
  ] as CFArray

/// The AX error a batched attribute read returned in place of a value, if any.
public func computerAXBatchError(_ value: AnyObject) -> AXError? {
  guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let wrapped = unsafeBitCast(value, to: AXValue.self)
  var error = AXError.success
  guard AXValueGetType(wrapped) == .axError, AXValueGetValue(wrapped, .axError, &error)
  else { return nil }
  return error
}

func computerAXValue<T>(_ value: AnyObject, _ type: AXValueType, _ empty: T) -> T? {
  guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let wrapped = unsafeBitCast(value, to: AXValue.self)
  var result = empty
  guard AXValueGetType(wrapped) == type, AXValueGetValue(wrapped, type, &result) else { return nil }
  return result
}

/// Parses one batched read of `computerSecureAuditAttributes`. Missing attributes come back
/// as embedded AX errors; children and subrole count as unreadable only for real errors.
public func computerSecureAuditNode(_ values: [AnyObject]) -> ComputerSecureAuditNode<AXUIElement>?
{
  guard values.count == 5 else { return nil }
  func readable(_ error: AXError?) -> Bool {
    error.map { $0 == .attributeUnsupported || $0 == .noValue } ?? true
  }
  let frame = computerAXValue(values[2], .cgPoint, CGPoint.zero).flatMap { point in
    computerAXValue(values[3], .cgSize, CGSize.zero).map { CGRect(origin: point, size: $0) }
  }
  let childrenError = computerAXBatchError(values[4])
  return ComputerSecureAuditNode(
    role: values[0] as? String, subrole: values[1] as? String, frame: frame,
    children: childrenError == nil ? values[4] as? [AXUIElement] ?? [] : [],
    childrenReadable: readable(childrenError),
    subroleReadable: readable(computerAXBatchError(values[1])))
}

/// Text and image leaves cannot contain a secure field; Chrome's inline text boxes under
/// them are a large share of a web page's nodes.
let computerSecureAuditLeafRoles: Set<String> = ["AXStaticText", "AXImage"]

/// Roles whose frame clips everything rendered beneath them, so the frame can stand in for
/// an unaudited subtree. Other AX frames need not contain their descendants: positioned,
/// transformed, top-layer or aria-owns web content renders outside its ancestors' boxes.
let computerSecureAuditClippingRoles: Set<String> = ["AXScrollArea", "AXWebArea"]

/// Row containers whose items AppKit can report as visible (`AXVisibleRows` for tables and
/// outlines, `AXVisibleChildren` for lists).
public let computerSecureAuditRowContainerRoles: Set<String> = ["AXTable", "AXOutline", "AXList"]

/// Below this many children a row container is walked in full, exactly as before.
public let computerSecureAuditLargeContainerChildren = 200

/// A row container's items as accessibility reports them: every item in order, the items it
/// reports as visible, and its non-item children (columns, headers).
public struct ComputerSecureAuditRowItems<Handle> {
  public var all: [Handle]
  public var visible: [Handle]
  public var others: [Handle]
  public init(all: [Handle], visible: [Handle], others: [Handle]) {
    self.all = all
    self.visible = visible
    self.others = others
  }
}

/// The visible items when they can stand in for every item of a row container clipped to
/// `region`, else nil. Items scrolled out of a clipping scroll area are never drawn, so only the
/// reported visible items need auditing, provided that report is current: the visible items
/// must be one contiguous run of `all`, and the items on either side of that run must have a
/// usable frame lying outside `region` (touching it by at most 1 pt). `neighborFrame` returns
/// nil when an item cannot be read or has no usable frame.
func computerSecureAuditVisibleRun<Handle: Hashable>(
  _ items: ComputerSecureAuditRowItems<Handle>, region: CGRect,
  neighborFrame: (Handle) -> CGRect?
) -> [Handle]? {
  guard !items.visible.isEmpty else { return nil }
  var index: [Handle: Int] = [:]
  for (position, item) in items.all.enumerated() {
    guard index.updateValue(position, forKey: item) == nil else { return nil }
  }
  var positions: [Int] = []
  for item in items.visible {
    guard let position = index[item] else { return nil }
    positions.append(position)
  }
  positions.sort()
  guard let first = positions.first, let last = positions.last,
    Set(positions).count == positions.count, last - first + 1 == positions.count
  else { return nil }
  for neighbor in [first - 1, last + 1] where items.all.indices.contains(neighbor) {
    guard let frame = neighborFrame(items.all[neighbor]), computerSecureAuditRectIsValid(frame)
    else { return nil }
    let overlap = frame.intersection(region)
    if !overlap.isNull && overlap.width > 1 && overlap.height > 1 { return nil }
  }
  return items.visible
}

struct SecureAuditEntry<Handle> {
  let handle: Handle
  let depth: Int
  /// Frame of the nearest clipping ancestor below the window root; nil means the window.
  let clip: CGRect?
}

/// This window's share of what remains of a capture's audit budget, taken once the window's
/// AX element is resolved. Time a fast window leaves unused rolls over to later windows.
public func computerSecureAuditDeadline(
  now: TimeInterval, end: TimeInterval, windowsLeft: Int
) -> TimeInterval {
  now + max(0, end - now) / Double(max(1, windowsLeft))
}

/// Breadth-first secure-field audit of one window. Fails closed: secure fields mask their own
/// frame, and anything that cannot be audited (unreadable, too deep, over budget, out of time,
/// or a secure field without a usable frame) masks its nearest clipping ancestor and marks the
/// audit incomplete. Returns nil, meaning mask the whole window, when the root is unreadable or
/// no clipping ancestor sits below the window.
///
/// An element whose role reads but whose subrole does not is still audited. A role that can
/// carry the secure subrole is masked at its own frame as a suspected field, and its children
/// are still walked, since AX frames need not contain their descendants. Any other childless
/// element is masked at its own frame; other roles walk on as usual.
///
/// A large row container under a clipping ancestor walks only its reported visible items and
/// its non-item children when `rowItems` supplies them and the report passes
/// `computerSecureAuditVisibleRun`; otherwise every child is walked as usual.
public func computerSecureAudit<Handle: Hashable>(
  root: Handle, read: (Handle) -> ComputerSecureAuditNode<Handle>?, maxDepth: Int,
  maxNodes: Int, expired: () -> Bool, search: ((Handle) -> [Handle]?)? = nil,
  children: ((Handle) -> [Handle]?)? = nil,
  rowItems: ((Handle, String) -> ComputerSecureAuditRowItems<Handle>?)? = nil,
  diagnostics: ComputerSecureAuditDiagnostics? = nil
) -> ComputerSecureAudit? {
  typealias Entry = SecureAuditEntry<Handle>
  var rects: [CGRect] = []
  var complete = true
  func append(_ rect: CGRect) {
    if !rects.contains(where: { $0.contains(rect) }) { rects.append(rect) }
  }
  /// Masks `region`, else the entry's clip. False when only the whole window can cover it.
  func unaudited(_ entry: Entry, region: CGRect? = nil) -> Bool {
    complete = false
    guard entry.depth > 0, let rect = region ?? entry.clip else { return false }
    append(rect)
    return true
  }
  var open = [Entry(handle: root, depth: 0, clip: nil)]
  var clipped: [Entry] = []
  var openHead = 0
  var clippedHead = 0
  var visited = 0
  while openHead < open.count || clippedHead < clipped.count {
    if visited >= maxNodes || expired() {
      diagnostics?.stop(visited >= maxNodes ? .nodeBudget : .deadline)
      if openHead < open.count { return nil }
      for entry in clipped[clippedHead...] {
        guard unaudited(entry) else { return nil }
      }
      break
    }
    let entry: Entry
    if openHead < open.count {
      entry = open[openHead]
      openHead += 1
    } else {
      entry = clipped[clippedHead]
      clippedHead += 1
    }
    visited += 1
    diagnostics?.visitNode()
    guard let node = read(entry.handle), let role = node.role else {
      diagnostics?.stop(.unreadableNode)
      guard unaudited(entry) else { return nil }
      continue
    }
    let own = node.frame.flatMap { computerSecureAuditRectIsValid($0) ? $0 : nil }
    if node.isSecureField {
      if let own {
        append(own)
      } else {
        diagnostics?.stop(.secureFieldWithoutFrame)
        if !unaudited(entry) { return nil }
      }
      continue
    }
    if !node.subroleReadable { diagnostics?.stop(.unreadableSubrole) }
    if node.isSuspectedSecureField {
      if let own {
        // Fall through: the field's children are still walked.
        append(own)
      } else {
        diagnostics?.stop(.secureFieldWithoutFrame)
        if !unaudited(entry) { return nil }
        // The masked clip covers this element's subtree.
        continue
      }
    }
    if computerSecureAuditLeafRoles.contains(role) { continue }
    let clip = computerSecureAuditClippingRoles.contains(role) ? own ?? entry.clip : entry.clip
    // Searching a web area can consume the budget too; finish native chrome first.
    if role == "AXWebArea", entry.clip == nil, entry.depth > 0, let clip {
      clipped.append(Entry(handle: entry.handle, depth: entry.depth, clip: clip))
      continue
    }
    if role == "AXWebArea", let results = search?(entry.handle) {
      // A limit-sized search cannot establish that there are no further fields.
      var safe = results.count < 5000 && !expired()
      if !safe {
        // The search may use a limit-sized sentinel for its own precise failure.
        if expired() {
          diagnostics?.stop(.deadline)
        } else if diagnostics?.lastSearchFailure == nil {
          diagnostics?.stop(.searchLimit)
        }
      }
      if safe {
        for handle in results {
          if visited >= maxNodes || expired() {
            diagnostics?.stop(visited >= maxNodes ? .nodeBudget : .deadline)
            safe = false
            break
          }
          visited += 1
          diagnostics?.visitNode()
          guard let field = read(handle), field.role != nil else {
            diagnostics?.stop(.unreadableNode)
            safe = false
            break
          }
          if !field.subroleReadable { diagnostics?.stop(.unreadableSubrole) }
          if field.mayBeSecureField {
            guard let frame = field.frame, computerSecureAuditRectIsValid(frame) else {
              diagnostics?.stop(.secureFieldWithoutFrame)
              safe = false
              break
            }
            append(frame)
          }
        }
      }
      if !safe && !unaudited(entry, region: clip) { return nil }
      continue
    }
    let listed: [Handle]?
    if let children { listed = children(entry.handle) } else { listed = node.children }
    guard var descendants = listed else {
      diagnostics?.stop(.unreadableChildren)
      guard unaudited(entry, region: clip) else { return nil }
      continue
    }
    if !node.childrenReadable || (entry.depth >= maxDepth && !descendants.isEmpty) {
      diagnostics?.stop(!node.childrenReadable ? .unreadableChildren : .depthLimit)
      guard unaudited(entry, region: clip) else { return nil }
      continue
    }
    // A childless element of another role whose subrole cannot be read fails closed at its
    // own frame; without a usable frame it has no on-screen area to mask.
    if !node.subroleReadable, !node.isSuspectedSecureField, descendants.isEmpty, let own {
      append(own)
    }
    if let rowItems, let entryClip = entry.clip,
      computerSecureAuditRowContainerRoles.contains(role),
      descendants.count >= computerSecureAuditLargeContainerChildren,
      let items = rowItems(entry.handle, role)
    {
      let region = own.map { $0.intersection(entryClip) } ?? entryClip
      let visible = computerSecureAuditVisibleRun(items, region: region) { neighbor in
        visited += 1
        diagnostics?.visitNode()
        return read(neighbor)?.frame
      }
      if let visible {
        let kept = items.others + visible
        diagnostics?.pruneRows(max(0, descendants.count - kept.count))
        descendants = kept
      }
    }
    for child in descendants {
      let next = Entry(handle: child, depth: entry.depth + 1, clip: entry.depth == 0 ? nil : clip)
      if next.clip == nil { open.append(next) } else { clipped.append(next) }
    }
  }
  return ComputerSecureAudit(rects: rects, complete: complete)
}
