import { SecretStoreError, ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Effect, Exit, FileSystem, Layer } from "effect";
import { it, assert } from "@effect/vitest";
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
            config: { serverPassword: "", serverUrl: "https://new.example.test" },
          },
        },
      });
      assert.equal(updated.providers.opencode.serverPassword, "global-password");
      assert.deepEqual(updated.providerInstances[id]?.config, {
        serverPassword: "instance-password",
        serverUrl: "https://new.example.test",
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

it.layer(layer)("Removed OpenCode credentials", (it) => {
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
