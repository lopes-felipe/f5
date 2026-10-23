import type { ServerProviderModel } from "@t3tools/contracts";
import { piRecordField, piRecordString } from "./PiProtocol.ts";
import { thinkingCapabilitiesForPiModel } from "./thinkingCapabilities.ts";

/** Provider identity is part of the slug: identical model IDs are not interchangeable. */
export function parsePiDiscoveredModels(
  data: unknown,
  state: unknown,
): readonly ServerProviderModel[] {
  const models = piRecordField(data, "models");
  if (!Array.isArray(models)) return [];
  const active = piRecordField(state, "model");
  const seen = new Set<string>();
  const result: ServerProviderModel[] = [];
  for (const model of models) {
    const provider = piRecordString(model, "provider")?.trim();
    const id = piRecordString(model, "id")?.trim();
    if (!provider || !id || provider.includes("/")) continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    result.push({
      slug,
      name: piRecordString(model, "name")?.trim() || slug,
      subProvider: provider,
      isCustom: false,
      capabilities: thinkingCapabilitiesForPiModel(
        model,
        provider === piRecordString(active, "provider") && id === piRecordString(active, "id")
          ? piRecordString(state, "thinkingLevel")
          : undefined,
      ),
    });
  }
  return result;
}
