import * as fs from "node:fs/promises";
import path from "node:path";
import type { AntigravitySettings, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Effect } from "effect";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import { antigravityProfileDirectory } from "../acp/AntigravityAcpSupport.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";

export async function hasAntigravityAccount(
  stateDir: string,
  instanceId: string,
): Promise<boolean> {
  try {
    const file = path.join(
      antigravityProfileDirectory(stateDir, instanceId),
      "antigravity-acp",
      "acp_token.json",
    );
    const stat = await fs.lstat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export const checkAntigravityProviderStatus = (
  settings: AntigravitySettings,
  stateDir: string,
  instanceId: string,
  discoveredModels?: ReadonlyArray<ServerProviderModel>,
) =>
  Effect.promise(async () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      discoveredModels?.length
        ? discoveredModels
        : [
            {
              slug: "antigravity-default",
              name: "Antigravity Default",
              isCustom: false,
              capabilities,
            },
          ],
      "antigravity",
      settings.customModels,
      capabilities,
    );
    // A status refresh is a local read. It never installs, starts ACP, or prompts for login.
    let installed = false;
    let authenticated = false;
    let version: string | null = null;
    if (settings.enabled) {
      try {
        const executable = await new AntigravityInstallation(stateDir).resolve();
        installed = true;
        version = executable.version;
      } catch {
        /* Setup is explicit. */
      }
      if (installed) authenticated = await hasAntigravityAccount(stateDir, instanceId);
    }
    return buildServerProvider({
      presentation: { displayName: "Antigravity", showInteractionModeToggle: false },
      enabled: settings.enabled,
      checkedAt: new Date().toISOString(),
      models,
      probe: {
        installed,
        version,
        status: authenticated ? "ready" : "warning",
        auth: { status: authenticated ? "authenticated" : "unauthenticated" },
        ...(!settings.enabled
          ? { message: "Antigravity is disabled." }
          : !installed
            ? { message: "Install Antigravity in Settings to get started." }
            : !authenticated
              ? { message: "Sign in to Antigravity in Settings." }
              : {}),
      },
    });
  });
