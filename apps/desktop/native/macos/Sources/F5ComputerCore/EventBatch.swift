public enum ComputerEventBatchError: Error { case outcomeUnknown }

/// A process-directed post is nonthrowing. Validation after any post cannot establish rollback.
public func computerRunEventBatch(
  count: Int, validate: () throws -> Void, post: (Int) -> Void
) throws {
  var posted = false
  for index in 0..<count {
    do { try validate() }
    catch {
      if posted { throw ComputerEventBatchError.outcomeUnknown }
      throw error
    }
    post(index)
    posted = true
  }
}
