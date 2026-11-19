import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { MODEL_OPTIONS_BY_PROVIDER, type ServerProvider } from "@t3tools/contracts";
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
export const MODEL_MANIFEST_URL =
  "https://raw.githubusercontent.com/lopes-felipe/f5/main/apps/server/src/provider/model-manifest.json";
const TTL = 60 * 60_000;
const RETRY = 5 * 60_000;

export function classifyModelManifest(
  provider: ServerProvider,
  manifest: ModelManifestData,
): ServerProvider {
  if (provider.driver !== "codex" && provider.driver !== "claudeAgent") return provider;
  const current = manifest.currentModels[provider.driver];
  if (!current) return provider;
  const catalog =
    provider.driver === "codex"
      ? MODEL_OPTIONS_BY_PROVIDER.codex
      : MODEL_OPTIONS_BY_PROVIDER.claudeAgent;
  const known = new Set<string>(catalog.map((model) => model.slug));
  return {
    ...provider,
    models: provider.models.map((model) =>
      model.isCustom
        ? model
        : {
            ...model,
            isLegacy: current.includes(model.slug.replace(/^openai[./]/, ""))
              ? false
              : known.has(model.slug.replace(/^openai[./]/, ""))
                ? true
                : undefined,
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
  const listeners = new Set<() => void>();
  const publishedAt = (data: ModelManifestData) => Date.parse(data.updatedAt ?? "") || 0;
  try {
    const cached = JSON.parse(await (input.readCache?.() ?? readFile(input.cachePath, "utf8"))) as {
      source?: unknown;
      fetchedAtMs?: unknown;
      manifest?: unknown;
    };
    const decoded = decode(cached.manifest);
    if (
      cached.source === MODEL_MANIFEST_URL &&
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
      const response = await (input.fetch ?? fetch)(MODEL_MANIFEST_URL, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
      });
      if (!response.ok) return;
      const next = decode(await response.json());
      if (controller.signal.aborted || publishedAt(next) < publishedAt(manifest)) return;
      const changed = JSON.stringify(manifest) !== JSON.stringify(next);
      manifest = next;
      fetchedAt = now();
      if (changed) for (const listener of listeners) listener();
      try {
        await save(
          JSON.stringify({ source: MODEL_MANIFEST_URL, fetchedAtMs: fetchedAt, manifest }),
        );
      } catch {
        /* Memory remains usable. */
      }
    } catch {
      /* Offline and schema errors never fail provider discovery. */
    }
  };
  return {
    current: () => manifest,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
    close: async () => {
      listeners.clear();
      controller.abort();
      await pending;
    },
  };
}
