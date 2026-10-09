import Darwin
import Foundation

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
