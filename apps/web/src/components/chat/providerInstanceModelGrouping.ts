import type { ProviderDriverKind } from "@t3tools/contracts";

export interface ModelCompanyInput {
  readonly driverKind: ProviderDriverKind;
  readonly instanceDisplayName: string;
  readonly name: string;
  readonly slug: string;
  readonly subProvider?: string | undefined;
}

const COMPANY_ALIASES: Readonly<Record<string, string>> = {
  alibaba: "Alibaba",
  anthropic: "Anthropic",
  aws: "Amazon",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  google: "Google",
  meta: "Meta",
  mistral: "Mistral",
  openai: "OpenAI",
  xai: "xAI",
};

const MODEL_COMPANY_MATCHERS: ReadonlyArray<{
  readonly company: string;
  readonly pattern: RegExp;
}> = [
  { company: "Anthropic", pattern: /(^|[^a-z0-9])claude([^a-z0-9]|$)/u },
  {
    company: "OpenAI",
    pattern: /(^|[^a-z0-9])(openai|chatgpt|gpt|o1|o3|o4)([^a-z0-9]|$)/u,
  },
  { company: "Google", pattern: /(^|[^a-z0-9])(google|gemini)([^a-z0-9]|$)/u },
  { company: "xAI", pattern: /(^|[^a-z0-9])(xai|grok)([^a-z0-9]|$)/u },
  { company: "Meta", pattern: /(^|[^a-z0-9])(meta|llama)([^a-z0-9]|$)/u },
  { company: "Mistral", pattern: /(^|[^a-z0-9])(mistral|codestral)([^a-z0-9]|$)/u },
  { company: "DeepSeek", pattern: /(^|[^a-z0-9])deepseek([^a-z0-9]|$)/u },
  { company: "Alibaba", pattern: /(^|[^a-z0-9])(alibaba|qwen)([^a-z0-9]|$)/u },
  { company: "Amazon", pattern: /(^|[^a-z0-9])(amazon|nova)([^a-z0-9]|$)/u },
  { company: "Cohere", pattern: /(^|[^a-z0-9])(cohere|command-r)([^a-z0-9]|$)/u },
];

const DRIVER_COMPANY: Readonly<Record<string, string>> = {
  claudeAgent: "Anthropic",
  codex: "OpenAI",
  grok: "xAI",
};

function canonicalCompanyLabel(value: string): string {
  const trimmed = value.trim();
  return COMPANY_ALIASES[trimmed.toLocaleLowerCase()] ?? trimmed;
}

/**
 * Resolve the model lab/company independently from the app used to run it.
 * Aggregators such as OpenCode provide `subProvider`; Cursor currently does
 * not, so known model-family names fill that metadata gap. Unknown families
 * stay grouped under their provider instance instead of being guessed.
 */
export function getModelCompanyLabel(input: ModelCompanyInput): string {
  if (input.subProvider?.trim()) {
    return canonicalCompanyLabel(input.subProvider);
  }

  const identity = `${input.slug} ${input.name}`.toLocaleLowerCase();
  const inferred = MODEL_COMPANY_MATCHERS.find(({ pattern }) => pattern.test(identity));
  if (inferred) return inferred.company;

  return DRIVER_COMPANY[input.driverKind] ?? input.instanceDisplayName;
}
