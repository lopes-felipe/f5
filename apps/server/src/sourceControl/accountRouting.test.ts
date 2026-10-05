import { it, assert } from "@effect/vitest";
import { Effect } from "effect";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../auth/Services/ServerSecretStore.ts";
import { makeForgeAccounts } from "./accountRouting.ts";
import { SqlClient } from "effect/unstable/sql";

it.layer(SqliteClient.layerMemory())("forge account routing", (it) => {
  it.effect(
    "isolates tokens per host and login and requires routing when an account is ambiguous",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE forge_accounts (id TEXT PRIMARY KEY,provider TEXT,host TEXT,login TEXT,viewer_id TEXT,generation TEXT,UNIQUE(provider,host,login))`;
        yield* sql`CREATE TABLE forge_account_routing (provider TEXT,host TEXT,repository TEXT,account_id TEXT,PRIMARY KEY(provider,host,repository))`;
        const values = new Map<string, Uint8Array>();
        const secrets: ServerSecretStoreShape = {
          get: (name) => Effect.succeed(values.get(name) ?? null),
          set: (name, value) =>
            Effect.sync(() => {
              values.set(name, value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              values.delete(name);
            }),
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
        };
        const calls: { url: string; token: string | null }[] = [];
        const accounts = yield* makeForgeAccounts({
          fetch: async (url, init) => {
            assert.equal(init?.redirect, "error");
            const token = new Headers(init?.headers).get("authorization");
            calls.push({ url: String(url), token });
            return Response.json({
              login: token === "Bearer alice-token" ? "alice" : "bob",
              id: token === "Bearer alice-token" ? 1 : 2,
            });
          },
        }).pipe(Effect.provideService(ServerSecretStore, secrets));
        const alice = yield* accounts.saveAccount({
          provider: "github",
          host: "ghe.example.com",
          token: "alice-token",
        });
        const bob = yield* accounts.saveAccount({
          provider: "github",
          host: "ghe.example.com",
          token: "bob-token",
        });
        const otherHost = yield* accounts.saveAccount({
          provider: "github",
          host: "other.example.com",
          token: "bob-token",
        });
        assert.notEqual(bob.id, otherHost.id);
        assert.equal(calls[0]?.url, "https://ghe.example.com/api/v3/user");
        assert.equal(yield* accounts.getToken(alice.id), "alice-token");
        assert.equal(yield* accounts.getToken(bob.id), "bob-token");
        const ref = {
          provider: "github" as const,
          host: "ghe.example.com",
          repository: "org/repo",
          number: 1,
        };
        assert.equal((yield* accounts.route(ref).pipe(Effect.result))._tag, "Failure");
        yield* accounts.setRouting({ ...ref, accountId: alice.id });
        assert.equal((yield* accounts.resolveAccount({ ref })).token, "alice-token");
        assert.equal(
          (yield* accounts.route({ ...ref, repository: "org/other" }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* accounts.setRouting({ ...ref, accountId: otherHost.id }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        assert.equal(
          (yield* accounts
            .setRouting({ ...ref, provider: "gitlab", accountId: alice.id })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* accounts.route({ ...ref, host: "other.example.com" })).id,
          otherHost.id,
        );
        assert.equal((yield* accounts.listRouting()).length, 1);
        const renewed = yield* accounts.saveAccount({
          provider: "github",
          host: "ghe.example.com",
          token: "alice-token",
        });
        assert.equal(renewed.id, alice.id);
        assert.notEqual(renewed.generation, alice.generation);
        assert.equal((yield* accounts.listAccounts()).length, 3);
        assert.equal(JSON.stringify(yield* accounts.listAccounts()).includes("alice-token"), false);
      }),
  );

  it.effect("rejects credential host escapes, redirects and oversized identity responses", () =>
    Effect.gen(function* () {
      const values = new Map<string, Uint8Array>();
      const secrets: ServerSecretStoreShape = {
        get: (name) => Effect.succeed(values.get(name) ?? null),
        set: (name, value) =>
          Effect.sync(() => {
            values.set(name, value);
          }),
        remove: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      };
      let calls = 0,
        cancelled = 0;
      const accounts = yield* makeForgeAccounts({
        fetch: async (_url, init) => {
          calls++;
          assert.equal(init?.redirect, "error");
          if (calls === 1)
            return new Response(null, {
              status: 302,
              headers: { location: "https://evil.example.com" },
            });
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(65537));
              },
              cancel() {
                cancelled++;
              },
            }),
          );
        },
      }).pipe(Effect.provideService(ServerSecretStore, secrets));
      for (const host of [
        "github.com:443",
        "github.com/evil",
        "user@github.com",
        "github.com..evil",
      ]) {
        assert.equal(
          (yield* accounts
            .saveAccount({ provider: "github", host, token: "secret" })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }
      for (const organization of [undefined, "../evil", "org/escape"]) {
        assert.equal(
          (yield* accounts
            .saveAccount({
              provider: "azure-devops",
              host: "dev.azure.com",
              token: "secret",
              ...(organization ? { organization } : {}),
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }
      assert.equal(calls, 0);
      assert.equal(
        (yield* accounts
          .saveAccount({ provider: "github", host: "github.com", token: "secret" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* accounts
          .saveAccount({ provider: "github", host: "github.com", token: "secret" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(cancelled, 1);
      assert.equal(values.size, 0);
    }),
  );
  it.effect("verifies each forge through its native identity endpoint and header", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS forge_accounts (id TEXT PRIMARY KEY,provider TEXT,host TEXT,login TEXT,viewer_id TEXT,generation TEXT,UNIQUE(provider,host,login))`;
      const values = new Map<string, Uint8Array>();
      const secrets: ServerSecretStoreShape = {
        get: (name) => Effect.succeed(values.get(name) ?? null),
        set: (name, value) =>
          Effect.sync(() => {
            values.set(name, value);
          }),
        remove: () => Effect.void,
        getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      };
      const fixtures = [
        {
          provider: "gitlab" as const,
          host: "gitlab.example.com",
          endpoint: "https://gitlab.example.com/api/v4/user",
          identity: { username: "gl", id: 10 },
          header: "PRIVATE-TOKEN",
          value: "secret",
        },
        {
          provider: "forgejo" as const,
          host: "forge.example.com",
          endpoint: "https://forge.example.com/api/v1/user",
          identity: { login: "fj", id: 11 },
          header: "Authorization",
          value: "Bearer secret",
        },
        {
          provider: "bitbucket" as const,
          host: "bitbucket.org",
          endpoint: "https://api.bitbucket.org/2.0/user",
          identity: { nickname: "bb", uuid: "uuid" },
          header: "Authorization",
          value: "Bearer secret",
        },
        {
          provider: "azure-devops" as const,
          host: "dev.azure.com",
          endpoint: "https://dev.azure.com/my-org/_apis/connectionData?api-version=7.1",
          identity: { authenticatedUser: { providerDisplayName: "az", id: "azure-id" } },
          header: "Authorization",
          value: `Basic ${Buffer.from(":secret").toString("base64")}`,
        },
      ];
      for (const fixture of fixtures) {
        const accounts = yield* makeForgeAccounts({
          fetch: async (url, init) => {
            assert.equal(String(url), fixture.endpoint);
            assert.equal(new Headers(init?.headers).get(fixture.header), fixture.value);
            assert.equal(init?.redirect, "error");
            return Response.json(fixture.identity);
          },
        }).pipe(Effect.provideService(ServerSecretStore, secrets));
        const saved = yield* accounts.saveAccount({
          provider: fixture.provider,
          host: fixture.host,
          token: "secret",
          ...(fixture.provider === "azure-devops" ? { organization: "my-org" } : {}),
        });
        assert.equal(saved.provider, fixture.provider);
        assert.equal(yield* accounts.getToken(saved.id), "secret");
      }
    }),
  );
});

it.layer(SqliteClient.layerMemory())("forge credential lifecycle", (it) => {
  it.effect(
    "retires rotated tokens, supports route removal, and removes account credentials and routes",
    () =>
      Effect.gen(function* () {
        const migration = yield* Effect.promise(
          () => import("../persistence/Migrations/102_ForgeAccounts.ts"),
        );
        yield* migration.default;
        const values = new Map<string, Uint8Array>();
        const secrets: ServerSecretStoreShape = {
          get: (name) => Effect.succeed(values.get(name) ?? null),
          set: (name, value) =>
            Effect.sync(() => {
              values.set(name, value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              values.delete(name);
            }),
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
        };
        const accounts = yield* makeForgeAccounts({
          fetch: async () => Response.json({ login: "alice", id: 1 }),
        }).pipe(Effect.provideService(ServerSecretStore, secrets));
        const first = yield* accounts.saveAccount({
          provider: "github",
          host: "github.com",
          token: "first",
        });
        const second = yield* accounts.saveAccount({
          provider: "github",
          host: "github.com",
          token: "second",
        });
        assert.notEqual(first.generation, second.generation);
        assert.equal(values.size, 1);
        assert.equal(yield* accounts.getToken(second.id), "second");
        const route = {
          provider: "github" as const,
          host: "github.com",
          repository: "team/repo",
          accountId: second.id,
        };
        yield* accounts.setRouting(route);
        yield* accounts.removeRouting(route);
        assert.equal((yield* accounts.listRouting()).length, 0);
        yield* accounts.setRouting(route);
        yield* accounts.removeAccount(second.id);
        assert.equal(values.size, 0);
        assert.equal((yield* accounts.listAccounts()).length, 0);
        assert.equal((yield* accounts.listRouting()).length, 0);
      }),
  );
});
