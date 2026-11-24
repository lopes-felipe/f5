/**
 * Settings rules for the Cursor harness.
 *
 * - Pinning: a profile that existed before the harness field gets an explicit
 *   `harness: "acp"` on every Cursor config, so a later change of the default
 *   never moves an existing provider to another harness.
 * - Immutability: a patch can never change the harness of an existing Cursor
 *   instance. Moving a thread between harnesses is a switch between two
 *   instances through F5's handoff.
 */
import type {
  ProviderInstanceConfig,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import type { CursorSdkAvailability } from "@t3tools/shared/cursorHarness";

import {
  cursorInstanceHarness,
  cursorInstanceHarnessIsExplicit,
} from "./cursorHarnessDescriptor.ts";

export const CURSOR_HARNESS_PINNED_MIGRATION = "cursorHarnessPinnedV1";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Load-time migration for documents written before the marker existed. It
 * runs before decoding, so the registry's first reconcile already sees the pin.
 */
export function pinCursorHarnessInDocument(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const migrations = document.clientSettingMigrations;
  if (migrations !== undefined && !isRecord(migrations)) return document;
  if (isRecord(migrations) && migrations[CURSOR_HARNESS_PINNED_MIGRATION]) return document;

  let next = document;
  const providers = isRecord(document.providers) ? document.providers : undefined;
  const legacy = providers && isRecord(providers.cursor) ? providers.cursor : undefined;
  if (!legacy || !cursorInstanceHarnessIsExplicit(legacy)) {
    next = {
      ...next,
      providers: { ...providers, cursor: { ...legacy, harness: "acp" } },
    };
  }
  if (isRecord(document.providerInstances)) {
    let changed = false;
    const instances = Object.fromEntries(
      Object.entries(document.providerInstances).map(([id, instance]) => {
        if (!isRecord(instance) || instance.driver !== "cursor") return [id, instance];
        const config = isRecord(instance.config) ? instance.config : {};
        if (cursorInstanceHarnessIsExplicit(config)) return [id, instance];
        changed = true;
        return [id, { ...instance, config: { ...config, harness: "acp" } }];
      }),
    );
    if (changed) next = { ...next, providerInstances: instances };
  }
  return next;
}

/**
 * Write-time counterpart of the load pin. The sparse serializer drops values
 * equal to the current defaults, which would drop `providers.cursor.harness`
 * while the migration marker is written, so the pin is put back explicitly.
 */
export function keepCursorHarnessPin(
  sparse: Record<string, unknown>,
  harness: ServerSettings["providers"]["cursor"]["harness"],
): Record<string, unknown> {
  const providers = isRecord(sparse.providers) ? sparse.providers : {};
  const legacy = isRecord(providers.cursor) ? providers.cursor : {};
  return { ...sparse, providers: { ...providers, cursor: { ...legacy, harness } } };
}

export type CursorHarnessPatchResult =
  | { readonly ok: true; readonly patch: ServerSettingsPatch }
  | { readonly ok: false; readonly issue: string };

const IMMUTABLE_ISSUE =
  "The harness of an existing Cursor provider cannot change. Add a separate Cursor provider for the other harness instead.";

/**
 * Validates a settings patch against the current settings. A Cursor instance
 * config that omits `harness` keeps its current harness rather than the
 * decoding default.
 */
export function pinCursorHarnessInPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
  sdkAvailability: CursorSdkAvailability,
): CursorHarnessPatchResult {
  const legacyHarness = patch.providers?.cursor?.harness;
  if (legacyHarness !== undefined && legacyHarness !== current.providers.cursor.harness)
    return { ok: false, issue: IMMUTABLE_ISSUE };
  if (!patch.providerInstances) return { ok: true, patch };

  let changed = false;
  const instances: Record<string, ProviderInstanceConfig> = {};
  const currentInstances: Readonly<Record<string, ProviderInstanceConfig | undefined>> =
    current.providerInstances;
  for (const [id, instance] of Object.entries(patch.providerInstances)) {
    instances[id] = instance;
    if (instance.driver !== "cursor") continue;
    const existing = currentInstances[id];
    const existingCursor = existing?.driver === "cursor" ? existing : undefined;
    const requested = cursorInstanceHarnessIsExplicit(instance.config)
      ? cursorInstanceHarness(instance.config)
      : undefined;
    if (existingCursor) {
      const pinned = cursorInstanceHarness(existingCursor.config);
      if (requested !== undefined && requested !== pinned)
        return { ok: false, issue: IMMUTABLE_ISSUE };
      if (requested === undefined && (instance.config === undefined || isRecord(instance.config))) {
        changed = true;
        instances[id] = { ...instance, config: { ...instance.config, harness: pinned } };
      }
      continue;
    }
    if (requested === "sdk" && !sdkAvailability.available)
      return { ok: false, issue: sdkAvailability.reason };
    // A new instance stores the harness it decodes to today, so a later
    // change of the decoding default cannot move it.
    if (requested === undefined && (instance.config === undefined || isRecord(instance.config))) {
      changed = true;
      instances[id] = {
        ...instance,
        config: { ...instance.config, harness: cursorInstanceHarness(instance.config) },
      };
    }
  }
  return changed
    ? {
        ok: true,
        patch: {
          ...patch,
          providerInstances: instances as NonNullable<ServerSettingsPatch["providerInstances"]>,
        },
      }
    : { ok: true, patch };
}
