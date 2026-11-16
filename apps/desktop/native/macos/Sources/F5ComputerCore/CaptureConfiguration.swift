import CoreGraphics
import ScreenCaptureKit

/// SCStreamConfiguration.backgroundColor is an assign (non-retaining) property.
/// Keep its owner alive until the asynchronous capture has returned or thrown.
/// `displaySize` is the captured display in points. The source and destination are set
/// explicitly so the output always maps the whole display onto the whole image; include-app
/// filters otherwise may not cover the full display.
public func withComputerCaptureConfiguration<Result>(
  width: Int, height: Int, displaySize: CGSize,
  capture: (SCStreamConfiguration) async throws -> Result
) async rethrows -> Result {
  // Transparent, so the canvas's own neutral fill shows through outside granted windows.
  // A colored background would pass through the capture's color matching and drift from
  // the reference the layout check compares against.
  let background = CGColor(gray: 0, alpha: 0)
  let configuration = SCStreamConfiguration()
  configuration.width = width
  configuration.height = height
  configuration.sourceRect = CGRect(origin: .zero, size: displaySize)
  configuration.destinationRect = CGRect(x: 0, y: 0, width: width, height: height)
  // Shadows extend past window frames and would read as content outside granted windows.
  configuration.ignoreShadowsDisplay = true
  configuration.showsCursor = false
  configuration.backgroundColor = background
  defer { withExtendedLifetime(background) {} }
  return try await capture(configuration)
}
