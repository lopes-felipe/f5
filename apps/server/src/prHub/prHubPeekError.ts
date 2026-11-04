import type { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

/** Preserve routing codes; forge permission failures do not imply a missing account. */
export function prHubPeekErrorCode(error: SourceControlProviderError): string | undefined {
  if (error.code) return error.code;
  if (error.kind === "unauthenticated") return "PrHubAccountRequired";
  if (error.kind === "forbidden") return "PrHubAccessDenied";
  return undefined;
}
