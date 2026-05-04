import type { ProviderStartOptions } from "@t3tools/contracts";

export function toClaudeProviderStartOptions(input: {
  readonly binaryPath: string | undefined;
}): ProviderStartOptions | undefined {
  if (!input.binaryPath) {
    return undefined;
  }

  return {
    claudeAgent: {
      binaryPath: input.binaryPath,
    },
  };
}
