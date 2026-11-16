import CoreGraphics

public enum ComputerCaptureCanvasError: Error { case invalidGeometry }

/// No authorized applications means no OS pixel read. A neutral image still
/// uses the same encoding/zoom path as a normal authorized capture.
public func authorizedComputerCaptureCanvas(
  width: Int, height: Int, applicationCount: Int,
  capture: () async throws -> CGImage
) async throws -> CGContext {
  guard width > 0, height > 0, applicationCount >= 0,
    let canvas = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw ComputerCaptureCanvasError.invalidGeometry }
  canvas.setFillColor(CGColor(gray: 0.45, alpha: 1))
  canvas.fill(CGRect(x: 0, y: 0, width: width, height: height))
  if applicationCount > 0 {
    let image = try await capture()
    canvas.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  }
  return canvas
}
