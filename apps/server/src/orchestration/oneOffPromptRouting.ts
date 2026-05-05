import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isKnownProviderKind,
  type ProviderKind,
} from "@t3tools/contracts";
import {
  inferProviderForModel,
  normalizeModelSlug,
  resolveModelSlugForProvider,
} from "@t3tools/shared/model";

const ONE_OFF_PROMPT_PROVIDERS = new Set<ProviderKind>(["codex", "claudeAgent"]);

function supportsOneOffPrompt(provider: ProviderKind): boolean {
  return ONE_OFF_PROMPT_PROVIDERS.has(provider);
}

function safeOneOffModelForProvider(provider: ProviderKind, model: string): string {
  const normalized = normalizeModelSlug(model, provider);
  if (normalized && resolveModelSlugForProvider(provider, normalized) === normalized) {
    return normalized;
  }
  return DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider];
}

export function resolveOneOffPromptRoute(input: {
  readonly model: string;
  readonly sessionProviderName?: string | null;
}): {
  readonly provider: ProviderKind;
  readonly model: string;
} {
  const sessionProvider = isKnownProviderKind(input.sessionProviderName)
    ? input.sessionProviderName
    : undefined;

  if (sessionProvider) {
    return supportsOneOffPrompt(sessionProvider)
      ? {
          provider: sessionProvider,
          model: safeOneOffModelForProvider(sessionProvider, input.model),
        }
      : {
          provider: "codex",
          model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
        };
  }

  const inferredProvider = inferProviderForModel(input.model, "codex");
  return supportsOneOffPrompt(inferredProvider)
    ? {
        provider: inferredProvider,
        model: safeOneOffModelForProvider(inferredProvider, input.model),
      }
    : {
        provider: "codex",
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
      };
}
