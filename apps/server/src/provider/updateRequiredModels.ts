import type { ServerProvider } from "@t3tools/contracts";
import { compareCliVersions } from "./cliVersion.ts";
import { VERSION_GATED_CLAUDE_MODELS } from "./Layers/ClaudeProvider.ts";

const CODEX_MODEL_GATES = [
  { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", minVersion: "0.153.0" },
  { slug: "gpt-6-astra", name: "GPT-6 Astra", minVersion: "0.153.0" },
  { slug: "gpt-6-luna", name: "GPT-6 Luna", minVersion: "0.155.0" },
];

/** Discovery wins over version hints, including qualified Codex model names. */
export function withUpdateRequiredModels(provider: ServerProvider): ServerProvider {
  const gates =
    provider.driver === "codex"
      ? CODEX_MODEL_GATES
      : provider.driver === "claudeAgent"
        ? VERSION_GATED_CLAUDE_MODELS
        : [];
  const available = new Set(
    provider.models
      .filter(
        (model) =>
          model.isUnlisted !== true &&
          (provider.driver !== "codex" || model.capabilities?.source === "reported"),
      )
      .map((model) => model.slug.replace(/^openai[./]/, "")),
  );
  const updateRequiredModels =
    provider.installed && provider.version
      ? gates.filter(
          (gate) =>
            !available.has(gate.slug) && compareCliVersions(provider.version!, gate.minVersion) < 0,
        )
      : [];
  const gated = new Set(updateRequiredModels.map((model) => model.slug));
  return {
    ...provider,
    updateRequiredModels,
    models: provider.models.map((model) =>
      gated.has(model.slug.replace(/^openai[./]/, "")) ? { ...model, isUnlisted: true } : model,
    ),
  };
}
