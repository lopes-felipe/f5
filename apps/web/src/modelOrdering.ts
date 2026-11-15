import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(Arr.map(values, (value, index) => [value, index] as const));
}

function toSet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order.Order<T> {
  return Order.mapInput(Order.Number, (item: T) => rank(item) ?? Number.POSITIVE_INFINITY);
}

function byTrueFirst<T>(predicate: (item: T) => boolean): Order.Order<T> {
  return Order.mapInput(Order.flip(Order.Boolean), predicate);
}

function capabilityProfile(slug: string): { family: string; key: number[] } {
  const id = slug.toLowerCase();
  const version = (id.match(/\d+(?:[.-]\d+)*/)?.[0] ?? "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => (Number(part) < 10_000 ? -Number(part) : 0));
  while (version.length < 3) version.push(0);
  if (/(?:claude|anthropic)/.test(id)) {
    const tier = ["fable", "mythos", "opus", "sonnet", "haiku"].findIndex((name) =>
      id.includes(name),
    );
    return { family: "claude", key: [tier < 0 ? 99 : tier, ...version] };
  }
  if (/(?:gpt-|^o[134](?:-|$))/.test(id)) {
    const tier = /astra|(?:^|-)pro(?:-|$)|codex-max/.test(id)
      ? 0
      : /nano/.test(id)
        ? 5
        : /luna|mini/.test(id)
          ? 4
          : /terra/.test(id)
            ? 3
            : 1;
    return { family: "gpt", key: [version[0]!, tier, ...version.slice(1)] };
  }
  if (id.includes("gemini")) {
    return {
      family: "gemini",
      key: [
        /carbon|ultra/.test(id)
          ? 0
          : /hydrogen|pro/.test(id)
            ? 1
            : /argon/.test(id)
              ? 2
              : /flash-lite/.test(id)
                ? 4
                : /flash/.test(id)
                  ? 3
                  : 1,
        ...version,
      ],
    };
  }
  if (id.includes("grok")) {
    return {
      family: "grok",
      key: [
        /heavy|expert/.test(id) ? 0 : /mini/.test(id) ? 3 : /fast/.test(id) ? 2 : 1,
        ...version,
      ],
    };
  }
  return { family: "other", key: [] };
}

/** Family tiers, then newest versions; unknown catalogs retain their reported order.
 * Manual ordering still wins. This is a browsing default, not a benchmark score.
 */
function capabilityRanks(models: ReadonlyArray<ModelSlugItem>): ReadonlyMap<string, number> {
  const profiles = new Map(models.map((model) => [model.slug, capabilityProfile(model.slug)]));
  const families = new Map<string, number>();
  for (const profile of profiles.values()) {
    if (!families.has(profile.family)) families.set(profile.family, families.size);
  }
  return rankByValue(
    [...models]
      .sort((a, b) => {
        const left = profiles.get(a.slug)!;
        const right = profiles.get(b.slug)!;
        const family = families.get(left.family)! - families.get(right.family)!;
        if (family) return family;
        for (let i = 0; i < Math.max(left.key.length, right.key.length); i++) {
          const difference = (left.key[i] ?? 0) - (right.key[i] ?? 0);
          if (difference) return difference;
        }
        return 0;
      })
      .map((model) => model.slug),
  );
}

export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    readonly modelOrder?: ReadonlyArray<string>;
    readonly favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
  },
): T[] {
  const modelOrder = options?.modelOrder ?? [];
  const favoriteModels = toSet(options?.favoriteModels);
  const orderBySlug = rankByValue(modelOrder);
  const originalOrder = rankByValue(Arr.map(models, (model) => model.slug));
  const capabilityOrder = capabilityRanks(models);
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [byTrueFirst<T>((model) => favoriteModels.has(model.slug))]
      : []),
    byOptionalRank((model) => orderBySlug.get(model.slug)),
    byOptionalRank((model) => capabilityOrder.get(model.slug)),
    byOptionalRank((model) => originalOrder.get(model.slug)),
  ];

  return Arr.sort(models, Order.combineAll(orders));
}

export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    readonly instanceOrder?: ReadonlyArray<ProviderInstanceId>;
  },
): T[] {
  const favoriteModelKeys = toSet(options?.favoriteModelKeys);
  const instanceOrder = new Map(
    Arr.map(options?.instanceOrder ?? [], (instanceId, index) => [instanceId, index] as const),
  );
  const originalOrder = rankByValue(
    Arr.map(items, (item) => providerModelKey(item.instanceId, item.slug)),
  );
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((item) =>
            favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => instanceOrder.get(item.instanceId)),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return Arr.sort(items, Order.combineAll(orders));
}
