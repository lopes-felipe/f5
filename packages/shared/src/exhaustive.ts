/** Fail closed when a supposedly exhaustive union gains an unhandled member. */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${String(value)}`);
}
