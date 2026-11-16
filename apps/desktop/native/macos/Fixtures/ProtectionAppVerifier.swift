import AppKit

// Fixed app identities, process metadata only. Normal termination is allowed
// only for a caller-identified process that was launched after a closed-app preflight.
// The coordinator never requests termination after physical input or PID drift.
let ids = ["com.apple.Terminal", "com.google.Chrome", "com.apple.TextEdit", "com.apple.calculator"]
let args = CommandLine.arguments
func emit(_ result: [String: Any]) {
  if let bytes = try? JSONSerialization.data(withJSONObject: result) {
    FileHandle.standardOutput.write(bytes)
  }
}
if args.count == 2 && args[1] == "--status" {
  var result: [String: Any] = [:]
  for id in ids {
    result[id] = NSRunningApplication.runningApplications(withBundleIdentifier: id)
      .filter { !$0.isTerminated }.map { Int($0.processIdentifier) }
  }
  emit(result)
} else if args.count == 4 && args[1] == "--terminate-owned",
  ids.contains(args[2]), let pid = Int32(args[3]), pid > 0,
  let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == args[2]
{
  emit(["requested": app.terminate()])
} else {
  emit(["error": "invalid-operation"])
  exit(2)
}
