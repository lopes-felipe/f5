import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

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
): ProviderTurnInputLengthIssue | null {
  const actualChars = input.trim().length;
  if (actualChars <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
    return null;
  }

  return {
    actualChars,
    maxChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    message: `Message is ${formatInteger(actualChars)} characters, which exceeds the ${formatInteger(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)} character provider input limit. Trim the pasted output or reference a file path instead.`,
  };
}
