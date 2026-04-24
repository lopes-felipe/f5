import type { ProviderStartOptions } from "@t3tools/contracts";

export function toCodexProviderStartOptions(input: {
  readonly binaryPath: string | undefined;
  readonly homePath: string | undefined;
}): ProviderStartOptions | undefined {
  if (!input.binaryPath && !input.homePath) {
    return undefined;
  }

  return {
    codex: {
      ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
      ...(input.homePath ? { homePath: input.homePath } : {}),
    },
  };
}
