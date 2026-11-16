import AppKit

// Images remain in memory. Emit only test outcomes, never pixels or captured text.
struct CaptureInput: Decodable {
  struct Rect: Decodable { let x, y, width, height: Int }
  let data: String
  let mimeType: String
  let secureRect: Rect?
  let blueRect: Rect?
  let greenRect: Rect?
  let neutralFrame: Bool?
  let requireBlue: Bool
}
let input = try JSONDecoder().decode(
  CaptureInput.self, from: FileHandle.standardInput.readDataToEndOfFile())
guard let data = Data(base64Encoded: input.data), let image = NSBitmapImageRep(data: data) else {
  exit(1)
}
func color(_ x: Int, _ y: Int) -> NSColor? {
  image.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB)
}
var blue = 0
var green = 0
// Sample points inside each marker rect. A 400x24 pt marker downscaled onto a wide display
// can be only a few pixels tall, so visibility scales with the samples the rect contains.
var blueSamples = 0
var greenSamples = 0
func contains(_ rect: CaptureInput.Rect?, _ x: Int, _ y: Int) -> Bool {
  guard let rect else { return true }
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}
for rect in [input.blueRect, input.greenRect].compactMap({ $0 }) {
  guard rect.width > 3, rect.height > 3, rect.x >= 0, rect.y >= 0,
    rect.x + rect.width <= image.pixelsWide, rect.y + rect.height <= image.pixelsHigh
  else { exit(1) }
}
for y in stride(from: 0, to: image.pixelsHigh, by: 3) {
  for x in stride(from: 0, to: image.pixelsWide, by: 3) {
    guard let pixel = color(x, y) else { exit(1) }
    if contains(input.blueRect, x, y) {
      blueSamples += 1
      if pixel.blueComponent > 0.7 && pixel.redComponent < 0.2 && pixel.greenComponent < 0.2 {
        blue += 1
      }
    }
    if contains(input.greenRect, x, y) {
      greenSamples += 1
      if pixel.greenComponent > 0.7 && pixel.redComponent < 0.2 && pixel.blueComponent < 0.2 {
        green += 1
      }
    }
  }
}
let blueVisible = blue > min(20, blueSamples / 2)
let greenVisible = green > min(20, greenSamples / 2)
var secureMasked = true
// Encode the known mask fill with the helper's color space and format. Comparing
// DeviceGray 0.45 directly to decoded DeviceRGB components gives a false failure.
guard
  let referenceCanvas = CGContext(
    data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
else { exit(1) }
referenceCanvas.setFillColor(CGColor(gray: 0.45, alpha: 1))
referenceCanvas.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
guard let referenceImage = referenceCanvas.makeImage(),
  let referenceData = NSBitmapImageRep(cgImage: referenceImage).representation(
    using: input.mimeType == "image/png" ? .png : .jpeg,
    properties: input.mimeType == "image/png" ? [:] : [.compressionFactor: 0.75]),
  let referenceBitmap = NSBitmapImageRep(data: referenceData),
  let neutral = referenceBitmap.colorAt(x: 0, y: 0)?.usingColorSpace(.deviceRGB)
else { exit(1) }
let reference = [neutral.redComponent, neutral.greenComponent, neutral.blueComponent]
guard reference.allSatisfy({ $0 > 0.3 && $0 < 0.8 }),
  reference.max()! - reference.min()! < 0.04
else { exit(1) }
var allNeutral = input.neutralFrame == true
if allNeutral {
  for y in 0..<image.pixelsHigh {
    for x in 0..<image.pixelsWide {
      guard let pixel = color(x, y) else { exit(1) }
      let components = [pixel.redComponent, pixel.greenComponent, pixel.blueComponent]
      allNeutral = allNeutral && zip(components, reference).allSatisfy { abs($0.0 - $0.1) < 0.04 }
    }
  }
}
if let rect = input.secureRect {
  guard rect.width > 8, rect.height > 8, rect.x >= 0, rect.y >= 0,
    rect.x + rect.width <= image.pixelsWide, rect.y + rect.height <= image.pixelsHigh
  else { exit(1) }
  for y in (rect.y + 3)..<(rect.y + rect.height - 3) {
    for x in (rect.x + 3)..<(rect.x + rect.width - 3) {
      guard let pixel = color(x, y) else { exit(1) }
      let components = [pixel.redComponent, pixel.greenComponent, pixel.blueComponent]
      secureMasked =
        secureMasked
        && zip(components, reference).allSatisfy {
          abs($0.0 - $0.1) < 0.04
        }
    }
  }
}
let outcomes: [String: Any] = [
  "grantedMarkerVisible": !input.requireBlue || blueVisible,
  "blueMarkerVisible": blueVisible,
  "ungrantedMarkerAbsent": green == 0,
  "greenMarkerVisible": greenVisible,
  "secureMasked": secureMasked,
  "allNeutral": allNeutral,
  "width": image.pixelsWide, "height": image.pixelsHigh,
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: outcomes))
