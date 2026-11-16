import Darwin
import Foundation

public func encodeComputerPacket(_ message: [String: Any], maximumSize: Int = 12 * 1024 * 1024)
  -> Data?
{
  guard let bytes = try? JSONSerialization.data(withJSONObject: message) else { return nil }
  if bytes.count <= maximumSize { return bytes }
  guard message["type"] as? String == "response", let id = message["requestId"] as? String,
    let bounded = try? JSONSerialization.data(withJSONObject: [
      "type": "response", "requestId": id, "error": ["_tag": "ResultTooLarge"],
    ]), bounded.count <= maximumSize
  else { return nil }
  return bounded
}

// FileHandle.read(upToCount:) can wait to fill its buffer on a pipe. The control
// channel must deliver each short NDJSON command immediately, with stdin open.
public func readComputerInputChunk(_ descriptor: Int32, maximumSize: Int = 65536) throws -> Data? {
  guard maximumSize > 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(EINVAL)) }
  var bytes = [UInt8](repeating: 0, count: maximumSize)
  while true {
    let count = Darwin.read(descriptor, &bytes, bytes.count)
    if count > 0 { return Data(bytes.prefix(count)) }
    if count == 0 { return nil }
    if errno != EINTR { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
  }
}
