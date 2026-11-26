import { Effect } from "effect";
import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import type { ServerSecretStoreShape } from "./auth/Services/ServerSecretStore.ts";
import {
  PROVIDER_INSTANCE_SECRET_FIELDS,
  applyServerSettingsPatch,
  providerInstanceSecretField,
  type ProviderInstanceSecretField,
} from "@t3tools/shared/serverSettings";

export interface SettingsSecretChange {
  readonly name: string;
  readonly value: Uint8Array | null;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const globalName = "provider-opencode-password";
const opencodeSecret = PROVIDER_INSTANCE_SECRET_FIELDS.opencode;
/** Secret-store name for a provider instance's secret field. */
export const providerInstanceSecretName = (secret: ProviderInstanceSecretField, id: string) =>
  `${secret.secretPrefix}${Buffer.from(id).toString("base64url")}`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function secretDestination(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
  const parsed = URL.parse(url);
  if (!parsed) return url;
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.href;
}

const cliProxyKey = "F5_CLIPROXY_API_KEY";

function cliProxyDestination(instance: ProviderInstanceConfig): string {
  const environment = new Map(instance.environment?.map(({ name, value }) => [name, value]));
  const hub = environment.get("F5_CLIPROXY_HUB_URL") ?? process.env.F5_CLIPROXY_HUB_URL;
  if (hub) return "hub:" + secretDestination(hub);
  if (instance.driver !== "antigravity") return "";
  const usage = environment.get("F5_CLIPROXY_USAGE_URL") ?? process.env.F5_CLIPROXY_USAGE_URL;
  return usage ? "usage:" + secretDestination(usage) : "";
}

/** Clear retained credentials before resolving secret-store references in the patched settings. */
export function applySettingsPatchWithSecretDestinations(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): { settings: ServerSettings; removals: SettingsSecretChange[] } {
  const next = applyServerSettingsPatch(current, patch);
  const removals: SettingsSecretChange[] = [];
  const clearMovedPassword = (
    config: Record<string, unknown>,
    previous: Record<string, unknown>,
    suppliedPassword: unknown,
    name: string,
  ) => {
    if (
      (typeof suppliedPassword === "string" && suppliedPassword.trim()) ||
      secretDestination(config.serverUrl) === secretDestination(previous.serverUrl)
    ) {
      return config;
    }
    removals.push({ name, value: null });
    return { ...config, serverPassword: "", serverPasswordRedacted: false };
  };

  const opencode = patch.providers?.opencode
    ? clearMovedPassword(
        next.providers.opencode,
        current.providers.opencode,
        patch.providers.opencode.serverPassword,
        globalName,
      )
    : next.providers.opencode;
  return {
    settings: {
      ...next,
      providers: {
        ...next.providers,
        opencode: opencode as ServerSettings["providers"]["opencode"],
      },
      providerInstances: patch.providerInstances
        ? Object.fromEntries(
            Object.entries(next.providerInstances).map(([id, instance]) => {
              const previous = current.providerInstances[id as ProviderInstanceId];
              if (previous?.driver !== instance.driver) return [id, instance];
              if (
                instance.driver === "opencode" &&
                record(instance.config) &&
                record(previous.config)
              ) {
                const suppliedConfig = patch.providerInstances?.[id as ProviderInstanceId]?.config;
                return [
                  id,
                  {
                    ...instance,
                    config: clearMovedPassword(
                      instance.config,
                      previous.config,
                      record(suppliedConfig) ? suppliedConfig.serverPassword : undefined,
                      providerInstanceSecretName(opencodeSecret, id),
                    ),
                  },
                ];
              }
              if (
                (instance.driver === "antigravity" || instance.driver === "grok") &&
                instance.environment?.some(
                  (row) => row.name === cliProxyKey && row.valueRedacted,
                ) &&
                cliProxyDestination(instance) !== cliProxyDestination(previous)
              ) {
                return [
                  id,
                  {
                    ...instance,
                    environment: instance.environment.map((row) =>
                      row.name === cliProxyKey && row.valueRedacted
                        ? { ...row, value: "", valueRedacted: false }
                        : row,
                    ),
                  },
                ];
              }
              return [id, instance];
            }),
          )
        : next.providerInstances,
      textGenerators: patch.textGenerators
        ? Object.fromEntries(
            Object.entries(next.textGenerators).map(([id, generator]) => {
              const previous = current.textGenerators[id as ProviderInstanceId];
              const moved =
                previous &&
                (previous.kind !== generator.kind ||
                  secretDestination(previous.baseUrl) !== secretDestination(generator.baseUrl));
              return [
                id,
                moved && !generator.apiKey ? { ...generator, apiKeyRedacted: false } : generator,
              ];
            }),
          )
        : next.textGenerators,
    },
    removals,
  };
}

/** Persist references only; inline values take precedence over an old reference. */
export function prepareSettingsSecrets(
  settings: ServerSettings,
  previous: ServerSettings = settings,
): {
  settings: ServerSettings;
  changes: SettingsSecretChange[];
} {
  const changes: SettingsSecretChange[] = [];
  const textGenerators = Object.fromEntries(
    Object.entries(settings.textGenerators).map(([id, generator]) => {
      const name = "text-generator-" + Buffer.from(id).toString("base64url");
      if (generator.apiKey) {
        changes.push({ name, value: encoder.encode(generator.apiKey) });
        return [id, { ...generator, apiKey: "", apiKeyRedacted: true }];
      }
      if (!generator.apiKeyRedacted) changes.push({ name, value: null });
      return [id, generator];
    }),
  );
  for (const id of Object.keys(previous.textGenerators)) {
    if (!Object.hasOwn(settings.textGenerators, id))
      changes.push({
        name: "text-generator-" + Buffer.from(id).toString("base64url"),
        value: null,
      });
  }
  const hadStoredSecret = (id: string, redactedField: string) => {
    const config = (previous.providerInstances as Record<string, { config?: unknown } | undefined>)[
      id
    ]?.config;
    return record(config) && config[redactedField] === true;
  };
  const protect = (
    config: Record<string, unknown>,
    name: string,
    secret: ProviderInstanceSecretField = opencodeSecret,
    { deleteWhenCleared = false }: { deleteWhenCleared?: boolean } = {},
  ) => {
    const value = config[secret.field];
    if (typeof value !== "string" || !value.trim()) {
      // A blank value without its reference is an explicit clear.
      if (deleteWhenCleared && config[secret.redactedField] !== true)
        changes.push({ name, value: null });
      return config;
    }
    changes.push({ name, value: encoder.encode(value.trim()) });
    return { ...config, [secret.field]: "", [secret.redactedField]: true };
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
    const secret = providerInstanceSecretField(instance.driver);
    if (
      secret &&
      settings.providerInstances[id as keyof typeof settings.providerInstances]?.driver !==
        instance.driver
    )
      changes.push({ name: providerInstanceSecretName(secret, id), value: null });
  }
  return {
    settings: {
      ...settings,
      textGenerators,
      ...(headers ? { observability: { ...settings.observability, otlpHeaders: headers } } : {}),
      providers: {
        ...settings.providers,
        opencode: protect(
          settings.providers.opencode,
          globalName,
        ) as ServerSettings["providers"]["opencode"],
      },
      providerInstances: Object.fromEntries(
        Object.entries(settings.providerInstances).map(([id, instance]) => {
          const secret = providerInstanceSecretField(instance.driver);
          return [
            id,
            secret && record(instance.config)
              ? {
                  ...instance,
                  config: protect(
                    instance.config,
                    providerInstanceSecretName(secret, id),
                    secret,
                    // OpenCode keeps its historical behaviour of never deleting on a blank save.
                    // Others delete only a secret that was stored, so saving an instance that
                    // never had one touches no secret-store entry.
                    {
                      deleteWhenCleared:
                        secret !== opencodeSecret && hadStoredSecret(id, secret.redactedField),
                    },
                  ),
                }
              : instance,
          ];
        }),
      ),
    },
    changes,
  };
}

export const OPENCODE_PASSWORD_UNAVAILABLE =
  "A stored OpenCode password is unavailable. Re-enter it in Settings.";
export const PROVIDER_SECRET_UNAVAILABLE =
  "A stored provider API key is unavailable. Re-enter it in Settings.";

/** A secret reference whose value was missing when the settings were read. */
export const isProviderSecretUnavailable = (
  secret: ProviderInstanceSecretField,
  config: Readonly<Record<string, unknown>>,
) => config[secret.redactedField] === true && !config[secret.field];

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
    const textGenerators = Object.fromEntries(
      yield* Effect.forEach(Object.entries(settings.textGenerators), ([id, generator]) =>
        Effect.gen(function* () {
          if (!generator.apiKeyRedacted || generator.apiKey) return [id, generator] as const;
          const secret = yield* store.get(
            "text-generator-" + Buffer.from(id).toString("base64url"),
          );
          return [
            id,
            secret
              ? { ...generator, apiKey: decoder.decode(secret), apiKeyRedacted: false }
              : generator,
          ] as const;
        }),
      ),
    );
    const hydrate = (
      config: Record<string, unknown>,
      name: string,
      field: ProviderInstanceSecretField = opencodeSecret,
    ) =>
      Effect.gen(function* () {
        if (config[field.redactedField] !== true || config[field.field]) return config;
        const secret = yield* store.get(name);
        if (!secret) {
          yield* Effect.logWarning(
            field === opencodeSecret ? OPENCODE_PASSWORD_UNAVAILABLE : PROVIDER_SECRET_UNAVAILABLE,
          );
          return config;
        }
        const { [field.redactedField]: _reference, ...rest } = config;
        return { ...rest, [field.field]: decoder.decode(secret) };
      });
    const opencode = yield* hydrate(settings.providers.opencode, globalName);
    const entries = yield* Effect.forEach(
      Object.entries(settings.providerInstances),
      ([id, instance]) =>
        Effect.gen(function* () {
          const secret = providerInstanceSecretField(instance.driver);
          return [
            id,
            secret && record(instance.config)
              ? {
                  ...instance,
                  config: yield* hydrate(
                    instance.config,
                    providerInstanceSecretName(secret, id),
                    secret,
                  ),
                }
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
      textGenerators,
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
