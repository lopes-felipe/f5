import { buildProviderChildProcessEnv } from "../providerProcessEnv";
import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return buildProviderChildProcessEnv(
    baseEnv,
    Object.fromEntries((environment ?? []).map((variable) => [variable.name, variable.value])),
  );
}
