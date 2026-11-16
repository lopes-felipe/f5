import { Effect } from "effect";
import type { ServerSettings } from "@t3tools/contracts";
import type { ServerSecretStoreShape } from "./auth/Services/ServerSecretStore.ts";

export interface SettingsSecretChange {
  readonly name: string;
  readonly value: Uint8Array | null;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const globalName = "provider-opencode-password";
const instanceName = (id: string) => `provider-password-${Buffer.from(id).toString("base64url")}`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Persist references only; inline values take precedence over an old reference. */
export function prepareSettingsSecrets(
  settings: ServerSettings,
  previous: ServerSettings = settings,
): {
  settings: ServerSettings;
  changes: SettingsSecretChange[];
} {
  const changes: SettingsSecretChange[] = [];
  const protect = (config: Record<string, unknown>, name: string) => {
    const value = config.serverPassword;
    if (typeof value !== "string" || !value.trim()) return config;
    changes.push({ name, value: encoder.encode(value.trim()) });
    return { ...config, serverPassword: "", serverPasswordRedacted: true };
  };
  const headers = settings.observability.otlpHeaders?.map((header) => {
    if (header.valueRedacted && !header.value) return header;
    const name = `observability-header-${Buffer.from(header.name.toLowerCase()).toString("base64url")}`;
    changes.push({ name, value: encoder.encode(header.value) });
    return { ...header, value: "", valueRedacted: true };
  });
  const headerNames = new Set(
    (settings.observability.otlpHeaders ?? []).map((header) => header.name.toLowerCase()),
  );
  for (const header of previous.observability.otlpHeaders ?? []) {
    if (!headerNames.has(header.name.toLowerCase()))
      changes.push({
        name: `observability-header-${Buffer.from(header.name.toLowerCase()).toString("base64url")}`,
        value: null,
      });
  }
  for (const [id, instance] of Object.entries(previous.providerInstances)) {
    if (
      instance.driver === "opencode" &&
      settings.providerInstances[id as keyof typeof settings.providerInstances]?.driver !==
        "opencode"
    )
      changes.push({ name: instanceName(id), value: null });
  }
  return {
    settings: {
      ...settings,
      ...(headers ? { observability: { ...settings.observability, otlpHeaders: headers } } : {}),
      providers: {
        ...settings.providers,
        opencode: protect(
          settings.providers.opencode,
          globalName,
        ) as ServerSettings["providers"]["opencode"],
      },
      providerInstances: Object.fromEntries(
        Object.entries(settings.providerInstances).map(([id, instance]) => [
          id,
          instance.driver === "opencode" && record(instance.config)
            ? { ...instance, config: protect(instance.config, instanceName(id)) }
            : instance,
        ]),
      ),
    },
    changes,
  };
}

export const OPENCODE_PASSWORD_UNAVAILABLE =
  "A stored OpenCode password is unavailable. Re-enter it in Settings.";

/** A password reference whose secret was missing when the settings were read. */
export const isOpenCodePasswordUnavailable = (config: {
  readonly serverPassword?: string;
  readonly serverPasswordRedacted?: boolean;
}) => config.serverPasswordRedacted === true && !config.serverPassword;

/**
 * A missing referenced secret keeps its reference instead of failing, so settings still load
 * (and the secret can be re-entered) after `settings.json` is restored without `secrets/`. Each
 * consumer fails closed on the reference: OpenCode reports the password unavailable and OTLP
 * export pauses, rather than either using an empty value.
 */
export const materializeSettingsSecrets = (
  settings: ServerSettings,
  store: ServerSecretStoreShape,
) =>
  Effect.gen(function* () {
    const hydrate = (config: Record<string, unknown>, name: string) =>
      Effect.gen(function* () {
        if (config.serverPasswordRedacted !== true || config.serverPassword) return config;
        const secret = yield* store.get(name);
        if (!secret) {
          yield* Effect.logWarning(OPENCODE_PASSWORD_UNAVAILABLE);
          return config;
        }
        const { serverPasswordRedacted: _reference, ...rest } = config;
        return { ...rest, serverPassword: decoder.decode(secret) };
      });
    const opencode = yield* hydrate(settings.providers.opencode, globalName);
    const entries = yield* Effect.forEach(
      Object.entries(settings.providerInstances),
      ([id, instance]) =>
        Effect.gen(function* () {
          return [
            id,
            instance.driver === "opencode" && record(instance.config)
              ? { ...instance, config: yield* hydrate(instance.config, instanceName(id)) }
              : instance,
          ] as const;
        }),
    );
    const headers = yield* Effect.forEach(settings.observability.otlpHeaders ?? [], (header) =>
      Effect.gen(function* () {
        if (!header.valueRedacted || header.value) return header;
        const secret = yield* store.get(
          `observability-header-${Buffer.from(header.name.toLowerCase()).toString("base64url")}`,
        );
        if (!secret) {
          yield* Effect.logWarning(
            "A stored observability header is unavailable, so OTLP export is paused. Re-enter it in Settings.",
          );
          return header;
        }
        return { name: header.name, value: decoder.decode(secret) };
      }),
    );
    return {
      ...settings,
      observability: {
        ...settings.observability,
        ...(settings.observability.otlpHeaders ? { otlpHeaders: headers } : {}),
      },
      providers: {
        ...settings.providers,
        opencode: opencode as ServerSettings["providers"]["opencode"],
      },
      providerInstances: Object.fromEntries(entries),
    } satisfies ServerSettings;
  });
