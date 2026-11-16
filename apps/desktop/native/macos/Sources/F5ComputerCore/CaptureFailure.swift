import Foundation
import ScreenCaptureKit

public enum ComputerCaptureStage: String {
  case permissionPreflight = "permission-preflight"
  case shareableContent = "shareable-content"
  case imageCapture = "image-capture"
}

/// No localized descriptions, userInfo, arbitrary domain strings or content.
public func computerCaptureFailureDiagnostic(
  stage: ComputerCaptureStage, error: Error? = nil
) -> [String: Any] {
  var result: [String: Any] = ["stage": stage.rawValue]
  if let error {
    let native = error as NSError
    result["domain"] = native.domain == SCStreamErrorDomain ? "screen-capture-kit" : "other"
    result["code"] = native.code
  }
  return result
}
