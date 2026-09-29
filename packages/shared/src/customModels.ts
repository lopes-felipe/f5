import {
  MODEL_OPTIONS_BY_PROVIDER,
  CustomModelSetting,
  type ProviderKind,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { normalizeModelSlug } from "./model";

export function customModelSlug(model: CustomModelSetting): string {
  return typeof model === "string" ? model : model.slug;
}

export function normalizeCustomModels(
  models: readonly CustomModelSetting[],
  provider?: ProviderKind | ProviderDriverKind | null,
  builtIns: ReadonlySet<string> = new Set(),
): CustomModelSetting[] {
  const catalog = provider
    ? (MODEL_OPTIONS_BY_PROVIDER as Record<string, readonly { slug: string }[] | undefined>)[
        provider
      ]
    : undefined;
  const seen = new Set([...builtIns, ...(catalog?.map((model) => model.slug) ?? [])]);
  let count = 0;
  return models.flatMap((model) => {
    const slug = provider
      ? normalizeModelSlug(customModelSlug(model), provider)
      : customModelSlug(model).trim();
    if (!slug || seen.has(slug) || (provider && (slug.length > 256 || count >= 32))) return [];
    count++;
    seen.add(slug);
    return [
      typeof model === "string"
        ? slug
        : { ...model, slug, ...(model.name ? { name: model.name.trim() } : {}) },
    ];
  });
}

export function readCustomModels(config: unknown): CustomModelSetting[] {
  if (
    !config ||
    typeof config !== "object" ||
    !("customModels" in config) ||
    !Array.isArray(config.customModels)
  )
    return [];
  return config.customModels.flatMap((value) => {
    const result = Schema.decodeUnknownOption(CustomModelSetting)(value);
    return result._tag === "Some" ? [result.value] : [];
  });
}
