import { AGENT_PROCESS_ENV, buildProviderChildProcessEnv } from "../providerProcessEnv";
import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...buildProviderChildProcessEnv(
      baseEnv,
      Object.fromEntries((environment ?? []).map((variable) => [variable.name, variable.value])),
    ),
    // Recursion guard: the Agent Bridge STDIO shim serves no tools to F5's own agents.
    [AGENT_PROCESS_ENV]: "1",
  };
}
