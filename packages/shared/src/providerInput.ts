import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import {
  exceedsThreadReferenceLimit,
  THREAD_REFERENCE_CONTEXT_MAX_CHARS,
  THREAD_REFERENCE_MAX_PER_MESSAGE,
  threadReferenceMatches,
} from "./threadReferences";

/**
 * Why a message references too many threads to send, or null. Past the cap a reference would
 * still show as a chip but the agent could not read it, so the send is refused instead.
 */
export function getThreadReferenceLimitIssue(text: string): { readonly message: string } | null {
  return exceedsThreadReferenceLimit(text)
    ? {
        message: `A message can reference up to ${THREAD_REFERENCE_MAX_PER_MESSAGE} threads. Remove some thread references and send again.`,
      }
    : null;
}

export interface ProviderTurnInputLengthIssue {
  readonly actualChars: number;
  readonly maxChars: number;
  readonly message: string;
}

function formatInteger(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function getProviderTurnInputLengthIssue(
  input: string,
  maxChars = PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
): ProviderTurnInputLengthIssue | null {
  const actualChars = input.trim().length;
  if (actualChars <= maxChars) {
    return null;
  }

  return {
    actualChars,
    maxChars,
    message: `Message is ${formatInteger(actualChars)} characters, which exceeds the ${formatInteger(maxChars)} character provider input limit. Trim the pasted output or reference a file path instead.`,
  };
}

/**
 * The length check for a message's own text. A message that references other threads leaves
 * room for the referenced-thread block the server appends before it reaches the provider.
 */
export function getMessageTextLengthIssue(
  text: string,
  maxChars = PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
): ProviderTurnInputLengthIssue | null {
  if (threadReferenceMatches(text).length === 0) {
    return getProviderTurnInputLengthIssue(text, maxChars);
  }
  const limit = Math.max(0, maxChars - THREAD_REFERENCE_CONTEXT_MAX_CHARS);
  const actualChars = text.trim().length;
  if (actualChars <= limit) {
    return null;
  }
  return {
    actualChars,
    maxChars: limit,
    message: `Message is ${formatInteger(actualChars)} characters, which exceeds the ${formatInteger(limit)} character limit for a message that references threads (F5 keeps room for referenced-thread context). Trim the message or reference a file path instead.`,
  };
}
