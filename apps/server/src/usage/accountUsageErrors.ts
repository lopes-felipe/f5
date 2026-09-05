import type { AccountUsageErrorCode } from "@t3tools/contracts";

export class AccountUsageReadError extends Error {
  constructor(readonly code: AccountUsageErrorCode) {
    super(code);
  }
}

// Never expose raw provider errors or account payloads across the transport.
export function accountUsageErrorCode(error: unknown): AccountUsageErrorCode {
  if (error instanceof AccountUsageReadError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    "_tag" in error &&
    error._tag === "CommandNotFoundError"
  )
    return "process-unavailable";
  if (error && typeof error === "object" && "_tag" in error && error._tag === "TimeoutError")
    return "timeout";
  const message = error instanceof Error ? error.message : "";
  if (/unauthori[sz]ed|authentication|not logged in|login required|\b401\b/i.test(message))
    return "authentication-required";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/ENOENT|spawn|executable|command.*not found/i.test(message)) return "process-unavailable";
  return "temporary-failure";
}
