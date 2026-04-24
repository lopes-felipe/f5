import { MODEL_OPTIONS_BY_PROVIDER, type ProviderKind } from "@t3tools/contracts";

export type HarnessBrandAccent = "claude" | "openai";

export interface HarnessMeta {
  readonly provider: ProviderKind;
  readonly displayName: string;
  readonly cliLabel: string;
  readonly installUrl: string;
  readonly brandAccent: HarnessBrandAccent;
  readonly supportedModels: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
  }>;
}

export const HARNESSES: ReadonlyArray<HarnessMeta> = [
  {
    provider: "claudeAgent",
    displayName: "Claude Code",
    cliLabel: "claude",
    installUrl: "https://code.claude.com/docs/en/quickstart",
    brandAccent: "claude",
    supportedModels: MODEL_OPTIONS_BY_PROVIDER.claudeAgent,
  },
  {
    provider: "codex",
    displayName: "Codex CLI",
    cliLabel: "codex",
    installUrl: "https://github.com/openai/codex#quickstart",
    brandAccent: "openai",
    supportedModels: MODEL_OPTIONS_BY_PROVIDER.codex,
  },
] as const;
