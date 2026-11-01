import { SHA_PATTERN } from "./release-candidate.ts";
export interface PublicationLease {
  sourceSha: string;
  candidateRun: number;
  attempt: number;
}
/** A completed selection that cannot publish anything in this workflow invocation. */
export type PublicationSelection = PublicationLease | { candidateRun: null };
export function parsePublicationSelection(value: unknown): PublicationSelection {
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    "candidateRun" in value &&
    value.candidateRun === null
  )
    return { candidateRun: null };
  return parsePublicationLease(value);
}
export function parsePublicationLease(value: unknown): PublicationLease {
  if (!value || typeof value !== "object") throw new Error("Missing publication lease");
  const lease = value as PublicationLease;
  if (
    typeof lease.sourceSha !== "string" ||
    !SHA_PATTERN.test(lease.sourceSha) ||
    !Number.isSafeInteger(lease.candidateRun) ||
    lease.candidateRun < 1 ||
    !Number.isSafeInteger(lease.attempt) ||
    lease.attempt < 1
  )
    throw new Error("Invalid publication lease");
  return { sourceSha: lease.sourceSha, candidateRun: lease.candidateRun, attempt: lease.attempt };
}
