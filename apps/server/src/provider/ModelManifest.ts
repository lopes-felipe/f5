import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ServerProvider } from "@t3tools/contracts";
import { Schema } from "effect";
import bundled from "./model-manifest.json" with { type: "json" };

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.optional(Schema.String),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type ModelManifestData = typeof Manifest.Type;
const decode = Schema.decodeUnknownSync(Manifest);
export const BUNDLED_MODEL_MANIFEST = decode(bundled);
const URL =
  "https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json";
const TTL = 60 * 60_000;
const RETRY = 5 * 60_000;

export function classifyModelManifest(
  provider: ServerProvider,
  manifest: ModelManifestData,
): ServerProvider {
  if (provider.driver !== "codex" && provider.driver !== "claudeAgent") return provider;
  const current = manifest.currentModels[provider.driver];
  if (!current) return provider;
  return {
    ...provider,
    models: provider.models.map((model) =>
      model.isCustom
        ? model
        : {
            ...model,
            isLegacy: !current.includes(model.slug.replace(/^openai[./]/, "")),
          },
    ),
  };
}

/** One registry owns the manifest, independently of individual provider lifetimes. */
export async function makeModelManifest(input: {
  cachePath: string;
  fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  readCache?: () => Promise<string>;
  writeCache?: (text: string) => Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let manifest = BUNDLED_MODEL_MANIFEST;
  let fetchedAt: number | null = null;
  let lastAttempt: number | null = null;
  let pending: Promise<void> | undefined;
  const controller = new AbortController();
  const publishedAt = (data: ModelManifestData) => Date.parse(data.updatedAt ?? "") || 0;
  try {
    const cached = JSON.parse(await (input.readCache?.() ?? readFile(input.cachePath, "utf8"))) as {
      fetchedAtMs?: unknown;
      manifest?: unknown;
    };
    const decoded = decode(cached.manifest);
    if (
      typeof cached.fetchedAtMs === "number" &&
      Number.isFinite(cached.fetchedAtMs) &&
      publishedAt(decoded) >= publishedAt(manifest)
    ) {
      manifest = decoded;
      fetchedAt = cached.fetchedAtMs;
    }
  } catch {
    /* A missing, obsolete, or corrupt cache uses the bundle. */
  }

  const save =
    input.writeCache ??
    (async (text: string) => {
      const temporary = input.cachePath + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, input.cachePath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  const refresh = async () => {
    try {
      const response = await (input.fetch ?? fetch)(URL, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
      });
      if (!response.ok) return;
      const next = decode(await response.json());
      if (controller.signal.aborted || publishedAt(next) < publishedAt(manifest)) return;
      manifest = next;
      fetchedAt = now();
      try {
        await save(JSON.stringify({ fetchedAtMs: fetchedAt, manifest }));
      } catch {
        /* Memory remains usable. */
      }
    } catch {
      /* Offline and schema errors never fail provider discovery. */
    }
  };
  return {
    current: () => manifest,
    refreshInBackground: (enabled: boolean) => {
      if (!enabled || pending || controller.signal.aborted) return;
      const at = now();
      const fresh = (since: number | null, duration: number) =>
        since !== null && at >= since && at - since < duration;
      if (fresh(fetchedAt, TTL) || fresh(lastAttempt, RETRY)) return;
      lastAttempt = at;
      pending = refresh().finally(() => {
        pending = undefined;
      });
    },
    settled: async () => {
      await pending;
    },
    close: () => controller.abort(),
  };
}
