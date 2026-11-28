import { SecretStoreError, ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { SECRET_STORE_KEY_FILE } from "./auth/secretStoreKey.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Effect, Exit, FileSystem, Layer } from "effect";
import { it, assert } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { resolveOtlpConfiguration } from "@t3tools/shared/observability";
import { ServerConfig } from "./config.ts";
import { isOpenCodePasswordUnavailable } from "./serverSettingsSecrets.ts";
import {
  ServerSettingsLiveWithSecretStore,
  ServerSettingsLive,
  ServerSettingsService,
  redactServerSettingsForClient,
} from "./serverSettings.ts";

const layer = ServerSettingsLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "f5-password-migration-" })),
  Layer.provideMerge(NodeServices.layer),
);
afterEach(() => vi.unstubAllEnvs());
it.effect("stores and preserves text generator keys outside settings", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* settings.start;
    const id = ProviderInstanceId.make("textgen_test");
    yield* settings.updateSettings({
      textGenerators: {
        [id]: {
          kind: "openaiCompatible",
          label: "Test",
          baseUrl: "https://example.test/v1",
          apiKey: "text-secret",
          models: ["model"],
          enabled: true,
        },
      },
    });
    assert.notInclude(yield* fs.readFileString(config.settingsPath!), "text-secret");
    const current = yield* settings.getSettings;
    assert.equal(current.textGenerators[id]?.apiKey, "text-secret");
    const collision = yield* Effect.exit(
      settings.updateSettings({
        providerInstances: { [id]: { driver: ProviderDriverKind.make("codex"), config: {} } },
      }),
    );
    assert.isTrue(Exit.isFailure(collision));
    const client = redactServerSettingsForClient(current);
    assert.equal(client.textGenerators[id]?.apiKey, "");
    yield* settings.updateSettings({
      textGenerators: { [id]: { ...client.textGenerators[id]!, label: "Renamed" } },
    });
    assert.equal((yield* settings.getSettings).textGenerators[id]?.apiKey, "text-secret");
    yield* settings.updateSettings({
      textGenerators: { [id]: { ...client.textGenerators[id]!, baseUrl: "https://other.test/v1" } },
    });
    assert.equal((yield* settings.getSettings).textGenerators[id]?.apiKey, "");
    assert.equal((yield* settings.getSettings).textGenerators[id]?.apiKeyRedacted, false);
    yield* settings.updateSettings({ textGenerators: {} });
    assert.deepEqual((yield* settings.getSettings).textGenerators, {});
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
it.effect("stores the Antigravity Gemini API key by reference and clears it on request", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* settings.start;
    const id = ProviderInstanceId.make("antigravity_key");
    const driver = ProviderDriverKind.make("antigravity");
    const key = "AIzaSyFixtureKey0000000000000";
    const configOf = (value: unknown) => value as Record<string, unknown> | undefined;
    yield* settings.updateSettings({
      providerInstances: {
        [id]: { driver, config: { authMethod: "gemini-api-key", apiKey: key } },
      },
    });
    const raw = yield* fs.readFileString(config.settingsPath!);
    assert.notInclude(raw, key);
    assert.include(raw, "apiKeyRedacted");
    const current = yield* settings.getSettings;
    assert.equal(configOf(current.providerInstances[id]?.config)?.apiKey, key);
    const client = redactServerSettingsForClient(current).providerInstances[id]!;
    assert.deepEqual(client.config, {
      authMethod: "gemini-api-key",
      apiKey: "",
      apiKeyRedacted: true,
    });

    // Saving the client's redacted copy keeps the key.
    yield* settings.updateSettings({
      providerInstances: { [id]: { ...client, displayName: "Gemini key" } },
    });
    assert.equal(
      configOf((yield* settings.getSettings).providerInstances[id]?.config)?.apiKey,
      key,
    );

    // "Remove stored key" sends a blank value without its reference.
    yield* settings.updateSettings({
      providerInstances: {
        [id]: { ...client, config: { ...configOf(client.config), apiKeyRedacted: false } },
      },
    });
    const cleared = configOf((yield* settings.getSettings).providerInstances[id]?.config);
    assert.equal(cleared?.apiKey, "");
    assert.notEqual(cleared?.apiKeyRedacted, true);
    yield* settings.updateSettings({ providerInstances: {} });
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
it.layer(layer)("OpenCode password persistence", (it) => {
  it.effect("migrates legacy global and instance passwords before startup is ready", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const id = ProviderInstanceId.make("opencode_work");
      yield* fs.writeFileString(
        config.settingsPath!,
        JSON.stringify({
          providers: { opencode: { serverPassword: "global-password" } },
          providerInstances: {
            [id]: {
              driver: "opencode",
              config: { serverPassword: "instance-password", serverUrl: "https://example.test" },
            },
          },
        }),
      );
      yield* settings.start;
      const current = yield* settings.getSettings;
      assert.equal(current.providers.opencode.serverPassword, "global-password");
      assert.deepEqual(current.providerInstances[id]?.config, {
        serverPassword: "instance-password",
        serverUrl: "https://example.test",
      });
      const raw = yield* fs.readFileString(config.settingsPath!);
      assert.notInclude(raw, "global-password");
      assert.notInclude(raw, "instance-password");
      assert.include(raw, "serverPasswordRedacted");
      const client = JSON.stringify(redactServerSettingsForClient(current));
      assert.notInclude(client, "global-password");
      assert.notInclude(client, "instance-password");
      const updated = yield* settings.updateSettings({
        providers: { opencode: { serverPassword: "" } },
        providerInstances: {
          [id]: {
            driver: ProviderDriverKind.make("opencode"),
            config: {
              serverPassword: "",
              serverUrl: "https://example.test",
              binaryPath: "/opt/opencode",
            },
          },
        },
      });
      assert.equal(updated.providers.opencode.serverPassword, "global-password");
      assert.deepEqual(updated.providerInstances[id]?.config, {
        serverPassword: "instance-password",
        serverUrl: "https://example.test",
        binaryPath: "/opt/opencode",
      });
      assert.notInclude(yield* fs.readFileString(config.settingsPath!), "instance-password");
    }),
  );
  it.effect("retains the legacy document when migration cannot persist its secret", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const raw = JSON.stringify({
        providers: { opencode: { serverPassword: "retained-legacy-password" } },
      });
      yield* fs.writeFileString(config.settingsPath!, raw);
      const failure = yield* Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* Effect.exit(service.start);
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ServerSettingsLiveWithSecretStore.pipe(
              Layer.provide(
                Layer.succeed(ServerSecretStore, {
                  get: () => Effect.succeed(null),
                  set: () =>
                    Effect.fail(
                      new SecretStoreError({ message: "Fixture secret store is unavailable" }),
                    ),
                  remove: () => Effect.void,
                  list: () => Effect.succeed([]),
                  getOrCreateRandom: () => Effect.die("unused"),
                }),
              ),
            ),
          ),
        ),
      );
      assert.isTrue(Exit.isFailure(failure));
      assert.equal(yield* fs.readFileString(config.settingsPath!), raw);
    }),
  );

  it.effect("starts with a missing password reference and leaves it unresolved", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath!,
        JSON.stringify({
          providers: { opencode: { serverPasswordRedacted: true } },
          observability: {
            otlpTracesUrl: "https://collector.example/v1/traces",
            otlpHeaders: [{ name: "authorization", value: "", valueRedacted: true }],
          },
        }),
      );
      const settings = yield* Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        // settings.json restored without secrets/ must not keep the backend from starting.
        yield* service.start;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ServerSettingsLiveWithSecretStore.pipe(
              Layer.provide(
                Layer.succeed(ServerSecretStore, {
                  get: () => Effect.succeed(null),
                  set: () => Effect.void,
                  remove: () => Effect.void,
                  list: () => Effect.succeed([]),
                  getOrCreateRandom: () => Effect.die("unused"),
                }),
              ),
            ),
          ),
        ),
      );
      // Consumers fail closed on the reference instead of using an empty value.
      assert.isTrue(isOpenCodePasswordUnavailable(settings.providers.opencode));
      assert.deepEqual(resolveOtlpConfiguration(settings.observability).traces, {
        url: null,
        source: "secret-unavailable",
        protocol: "http/protobuf",
        headers: {},
      });
    }),
  );

  it.effect(
    "keeps collector headers out of settings reads and rolls their references forward",
    () =>
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const config = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const next = yield* service.updateSettings({
          observability: {
            otlpHeaders: [{ name: "Authorization", value: "Bearer collector-credential" }],
          },
        });
        assert.equal(next.observability.otlpHeaders?.[0]?.value, "Bearer collector-credential");
        assert.notInclude(yield* fs.readFileString(config.settingsPath!), "collector-credential");
        const client = redactServerSettingsForClient(next);
        assert.deepEqual(client.observability.otlpHeaders, [
          { name: "Authorization", value: "", valueRedacted: true },
        ]);
        const retained = yield* service.updateSettings({
          observability: { otlpHeaders: client.observability.otlpHeaders! },
        });
        assert.equal(retained.observability.otlpHeaders?.[0]?.value, "Bearer collector-credential");
        yield* service.updateSettings({ observability: { otlpHeaders: [] } });
        assert.deepEqual((yield* service.getSettings).observability.otlpHeaders, []);
      }),
  );

  it.effect("never writes new or replaced passwords into settings.json", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      for (const password of ["new-password", "replacement-password"]) {
        const current = yield* settings.updateSettings({
          providers: { opencode: { serverPassword: password } },
        });
        assert.equal(current.providers.opencode.serverPassword, password);
        assert.notInclude(yield* fs.readFileString(config.settingsPath!), password);
        assert.equal((yield* settings.getSettings).providers.opencode.serverPassword, password);
      }
    }),
  );
});

it.effect("binds saved OpenCode passwords and text generator keys to their URLs", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const opencode = ProviderInstanceId.make("opencode_remote");
    const textGenerator = ProviderInstanceId.make("textgen_remote");
    const save = (url: string, password?: string) =>
      service.updateSettings({
        providers: {
          opencode: {
            serverUrl: url,
            ...(password === undefined ? {} : { serverPassword: password }),
          },
        },
        providerInstances: {
          [opencode]: {
            driver: ProviderDriverKind.make("opencode"),
            config: { serverUrl: url, serverPassword: password ?? "" },
          },
        },
        textGenerators: {
          [textGenerator]: {
            kind: "openaiCompatible",
            label: "Remote",
            baseUrl: url,
            apiKey: password ?? "",
            apiKeyRedacted: !password,
            models: ["model"],
            enabled: true,
          },
        },
      });
    const assertCredentials = Effect.fnUntraced(function* (expected: string) {
      const settings = yield* service.getSettings;
      assert.equal(settings.providers.opencode.serverPassword, expected);
      assert.propertyVal(settings.providerInstances[opencode]?.config, "serverPassword", expected);
      assert.equal(settings.textGenerators[textGenerator]?.apiKey, expected);
    });

    const original = "https://example.test/v1";
    yield* save(original);
    assert.notInclude(yield* fs.readFileString(config.settingsPath!), "serverPasswordRedacted");
    yield* save(original, "saved-credential");
    yield* save("HTTPS://EXAMPLE.test:443/v1//");
    yield* assertCredentials("saved-credential");
    for (const url of [
      "https://elsewhere.test/v1",
      "https://example.test:8443/v1",
      "https://example.test/V1",
    ]) {
      yield* save(original, "saved-credential");
      yield* save(url);
      yield* assertCredentials("");
      const files = yield* fs.readDirectory(config.secretsDir!);
      assert.deepEqual(
        files.filter((file) => file !== SECRET_STORE_KEY_FILE + ".bin"),
        [],
      );
    }
    yield* save(original, "saved-credential");
    yield* save("https://example.test/v2", "saved-credential");
    yield* assertCredentials("saved-credential");
    const saved = yield* service.getSettings;
    const generator = saved.textGenerators[textGenerator]!;
    yield* service.updateSettings({
      textGenerators: {
        [textGenerator]: { ...generator, kind: "anthropic", apiKey: "", apiKeyRedacted: true },
      },
    });
    const changed = yield* service.getSettings;
    assert.equal(changed.textGenerators[textGenerator]?.apiKey, "");
    assert.equal(changed.providers.opencode.serverPassword, "saved-credential");
    assert.propertyVal(
      changed.providerInstances[opencode]?.config,
      "serverPassword",
      "saved-credential",
    );
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("clears a retained CLIProxyAPI key when its hub destination changes", () =>
  Effect.gen(function* () {
    vi.stubEnv("F5_CLIPROXY_HUB_URL", "");
    const service = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const id = ProviderInstanceId.make("grok_usage");
    const keyName = "F5_CLIPROXY_API_KEY";
    const save = (
      hub: string | undefined,
      key?: string,
      options: {
        driver?: "antigravity" | "grok";
        sensitiveHub?: "new" | "retained";
        duplicateKey?: boolean;
      } = {},
    ) =>
      service.updateSettings({
        providerInstances: {
          [id]: {
            driver: ProviderDriverKind.make(options.driver ?? "grok"),
            config: {},
            environment: [
              ...(hub === undefined
                ? []
                : [
                    {
                      name: "F5_CLIPROXY_HUB_URL",
                      value: hub,
                      sensitive: options.sensitiveHub !== undefined,
                      valueRedacted: options.sensitiveHub === "retained",
                    },
                  ]),
              {
                name: keyName,
                value: key ?? "",
                valueRedacted: key === undefined,
                sensitive: true,
              },
              ...(options.duplicateKey
                ? [{ name: keyName, value: "", sensitive: true, valueRedacted: true }]
                : []),
            ],
          },
        },
      });
    const assertKey = Effect.fnUntraced(function* (expected: string) {
      const settings = yield* service.getSettings;
      const key = settings.providerInstances[id]?.environment?.find((row) => row.name === keyName);
      assert.equal(key?.value, expected);
      assert.equal(Boolean(key?.valueRedacted), Boolean(expected));
      const files = yield* fs.readDirectory(config.secretsDir!);
      const keyFileSuffix = "-" + Buffer.from(keyName).toString("base64url") + ".bin";
      assert.equal(
        files.some((file) => file.endsWith(keyFileSuffix)),
        Boolean(expected),
      );
    });

    const hub = "https://example.test/hub";
    yield* save(hub, "management-fixture");
    yield* save("https://EXAMPLE.test:443/hub/management.html?tab=usage#overview");
    yield* assertKey("management-fixture");
    yield* save("https://example.test/other-hub");
    yield* assertKey("");
    yield* save(hub, "hub-fixture", { sensitiveHub: "new" });
    yield* save("", undefined, { sensitiveHub: "retained" });
    yield* assertKey("hub-fixture");
    const hubFileSuffix = "-" + Buffer.from("F5_CLIPROXY_HUB_URL").toString("base64url") + ".bin";
    const hubFile = (yield* fs.readDirectory(config.secretsDir!)).find((file) =>
      file.endsWith(hubFileSuffix),
    );
    assert.isDefined(hubFile);
    yield* fs.remove(config.secretsDir! + "/" + hubFile);
    yield* save("", undefined, { sensitiveHub: "retained" });
    yield* assertKey("hub-fixture");
    yield* save(undefined);
    yield* assertKey("");
    yield* save(hub, "antigravity-fixture", { driver: "antigravity" });
    yield* save(hub, undefined, { driver: "grok" });
    yield* assertKey("");
    yield* save(hub, "grok-fixture");
    yield* save(hub + "/new", "new-grok-fixture", { duplicateKey: true });
    yield* assertKey("new-grok-fixture");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.layer(layer)("Removed OpenCode credentials", (it) => {
  it.effect("cannot revive a password after dropping its config or saved reference", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      const id = ProviderInstanceId.make("opencode_rebound");
      const driver = ProviderDriverKind.make("opencode");
      const original = "https://old.example";
      const moved = "https://new.example";
      const save = (config?: Record<string, unknown>) =>
        service.updateSettings({
          providerInstances: { [id]: { driver, ...(config && { config }) } },
        });
      for (const dropped of [undefined, { serverUrl: original }]) {
        yield* save({ serverUrl: original, serverPassword: "stored-fixture" });
        yield* save(dropped);
        yield* save({ serverUrl: moved });
        const result = yield* save({ serverUrl: moved, serverPasswordRedacted: true });
        assert.deepEqual(result.providerInstances[id]?.config, { serverUrl: moved });
      }
    }),
  );
  it.effect(
    "removes a deleted instance's password through the ordinary settings transaction",
    () => {
      const values = new Map<string, Uint8Array>();
      return Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const id = ProviderInstanceId.make("opencode_temporary");
        yield* service.updateSettings({
          providerInstances: {
            [id]: {
              driver: ProviderDriverKind.make("opencode"),
              config: { serverPassword: "temporary-password" },
            },
          },
        });
        assert.isTrue(
          [...values.values()].some(
            (value) => new TextDecoder().decode(value) === "temporary-password",
          ),
        );
        yield* service.updateSettings({ providerInstances: {} });
        assert.isFalse(
          [...values.values()].some(
            (value) => new TextDecoder().decode(value) === "temporary-password",
          ),
        );
        assert.isUndefined((yield* service.getSettings).providerInstances[id]);
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ServerSettingsLiveWithSecretStore.pipe(
              Layer.provide(
                Layer.succeed(ServerSecretStore, {
                  get: (name) => Effect.succeed(values.get(name) ?? null),
                  set: (name, value) =>
                    Effect.sync(() => {
                      values.set(name, value);
                    }),
                  remove: (name) =>
                    Effect.sync(() => {
                      values.delete(name);
                    }),
                  list: () =>
                    Effect.succeed([...values.keys()].map((name) => ({ name, modifiedAt: 0 }))),
                  getOrCreateRandom: () => Effect.die("unused"),
                }),
              ),
            ),
          ),
        ),
      );
    },
  );
});

it.layer(layer)("Missing password repair", (it) => {
  it.effect(
    "keeps a missing secret's reference through unrelated edits until it is replaced",
    () => {
      const values = new Map<string, Uint8Array>();
      return Effect.gen(function* () {
        const config = yield* ServerConfig,
          fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          config.settingsPath!,
          JSON.stringify({ providers: { opencode: { serverPasswordRedacted: true } } }),
        );
        const service = yield* ServerSettingsService;
        yield* service.updateSettings({ autoPullDefaultBranch: false });
        assert.isTrue(
          JSON.parse(yield* fs.readFileString(config.settingsPath!)).providers.opencode
            .serverPasswordRedacted,
        );
        const repaired = yield* service.updateSettings({
          providers: { opencode: { serverPassword: "repaired-password" } },
        });
        assert.equal(repaired.providers.opencode.serverPassword, "repaired-password");
        assert.notInclude(yield* fs.readFileString(config.settingsPath!), "repaired-password");
        assert.equal(
          (yield* service.getSettings).providers.opencode.serverPassword,
          "repaired-password",
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(
            ServerSettingsLiveWithSecretStore.pipe(
              Layer.provide(
                Layer.succeed(ServerSecretStore, {
                  get: (name) => Effect.succeed(values.get(name) ?? null),
                  set: (name, value) =>
                    Effect.sync(() => {
                      values.set(name, value);
                    }),
                  remove: (name) =>
                    Effect.sync(() => {
                      values.delete(name);
                    }),
                  list: () =>
                    Effect.succeed([...values.keys()].map((name) => ({ name, modifiedAt: 0 }))),
                  getOrCreateRandom: () => Effect.die("unused"),
                }),
              ),
            ),
          ),
        ),
      );
    },
  );
});
