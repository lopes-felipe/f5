import CoreGraphics

/// Maps a rectangle in global display points to canvas pixels with a top-left origin.
public func computerCanvasRect(
  _ rect: CGRect, display: CGRect, canvasWidth: Int, canvasHeight: Int
) -> CGRect {
  let scaleX = Double(canvasWidth) / display.width
  let scaleY = Double(canvasHeight) / display.height
  return CGRect(
    x: (rect.minX - display.minX) * scaleX, y: (rect.minY - display.minY) * scaleY,
    width: rect.width * scaleX, height: rect.height * scaleY)
}

/// The menu bar strip across the top of `display`, in global points. Its height comes from
/// the main-menu-level windows on that display, capped at 64 pt so a stray full-height
/// window at that level cannot disable the layout check. Falls back to 44 pt, enough for
/// notched displays, when no menu window is found.
public func computerMenuBarBand(display: CGRect, menuWindows: [CGRect]) -> CGRect {
  let heights = menuWindows.filter { $0.intersects(display) && $0.minY <= display.minY + 1 }
    .map { $0.maxY - display.minY }
  let height = min(64, heights.max() ?? 44)
  return CGRect(x: display.minX, y: display.minY, width: display.width, height: max(0, height))
}

/// Converts a top-left-origin canvas rect to the bottom-left origin Core Graphics draws with.
public func computerCanvasDrawRect(_ rect: CGRect, canvasHeight: Int) -> CGRect {
  CGRect(x: rect.minX, y: Double(canvasHeight) - rect.maxY, width: rect.width, height: rect.height)
}

/// True when the canvas holds content outside `allowed` (canvas pixels, top-left origin).
/// Only granted windows are captured, so anything but the neutral fill elsewhere means the
/// capture does not line up with the display. Samples a stride-2 grid; a sample counts when
/// any channel is more than 12/255 from the neutral fill, and more than 64 counts fail.
/// An unreadable canvas also fails.
public func computerCaptureContentOutside(_ canvas: CGContext, allowed: [CGRect]) -> Bool {
  guard canvas.bitsPerPixel == 32, let data = canvas.data,
    let reference = computerNeutralCanvasPixel()
  else { return true }
  let pixels = data.assumingMemoryBound(to: UInt8.self)
  let expanded = allowed.map { $0.insetBy(dx: -2, dy: -2) }
  var outside = 0
  // Bitmap rows run top-down, matching the top-left origin of `allowed`.
  for y in stride(from: 0, to: canvas.height, by: 2) {
    let row = expanded.filter { Double(y) + 0.5 >= $0.minY && Double(y) + 0.5 < $0.maxY }
    for x in stride(from: 0, to: canvas.width, by: 2) {
      let center = Double(x) + 0.5
      if row.contains(where: { center >= $0.minX && center < $0.maxX }) { continue }
      let offset = y * canvas.bytesPerRow + x * 4
      if (0..<3).contains(where: { abs(Int(pixels[offset + $0]) - reference[$0]) > 12 }) {
        outside += 1
        if outside > 64 { return true }
      }
    }
  }
  return false
}

/// The neutral fill as it lands in the capture canvas format.
func computerNeutralCanvasPixel() -> [Int]? {
  guard
    let context = CGContext(
      data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
    let data = context.data
  else { return nil }
  context.setFillColor(CGColor(gray: 0.45, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
  let pixel = data.assumingMemoryBound(to: UInt8.self)
  return [Int(pixel[0]), Int(pixel[1]), Int(pixel[2])]
}

/// Foreground actions without coordinates follow the focused window, never an arbitrary first
/// display or the user's pointer. An unresolved explicit ID remains unresolved.
public func computerActionDisplayID(
  requestedID: String?, windowFrame: CGRect?, displays: [(id: String, bounds: CGRect)]
) -> String? {
  if let requestedID, !requestedID.isEmpty {
    return displays.first(where: { $0.id == requestedID })?.id
  }
  guard let windowFrame, computerSecureAuditRectIsValid(windowFrame) else { return nil }
  let center = CGPoint(x: windowFrame.midX, y: windowFrame.midY)
  return displays.first(where: { $0.bounds.contains(center) })?.id
}
