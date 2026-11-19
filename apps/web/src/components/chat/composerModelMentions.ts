import type { ServerProvider } from "@t3tools/contracts";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

export function composerModelMentionItems(
  providers: readonly ServerProvider[],
  query: string,
): Extract<ComposerCommandItem, { type: "model" }>[] {
  const words = query
    .toLowerCase()
    .replace(/[:/-]+/gu, " ")
    .trim()
    .split(/\s+/u);
  if (words.join("").length < 2) return [];
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.models.flatMap((model) => {
        const fields = [
          model.name,
          model.slug,
          model.subProvider,
          provider.driver,
          provider.displayName,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .split(/[^\p{L}\p{N}.]+/u);
        if (!words.every((word) => fields.some((field) => field.startsWith(word)))) return [];
        return [
          {
            id: "model:" + provider.instanceId + "/" + model.slug,
            type: "model" as const,
            instanceId: provider.instanceId,
            model: model.slug,
            label: model.name,
            description: provider.displayName ?? provider.driver,
          },
        ];
      }),
    )
    .slice(0, 8);
}
