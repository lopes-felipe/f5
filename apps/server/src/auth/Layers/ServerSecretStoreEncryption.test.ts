import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../Services/ServerSecretStore.ts";
import { isEncryptedSecretValue, parseSecretStoreKey } from "../secretStoreKey.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stateDir() {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "f5-secret-encryption-"));
  dirs.push(dir);
  return nodePath.join(dir, "userdata");
}

function run<A, E>(
  dir: string,
  key: Uint8Array | undefined,
  effect: Effect.Effect<A, E, ServerSecretStore>,
): Promise<A> {
  const config = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig;
      return { ...base, ...(key ? { secretStoreKey: key } : {}) };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), dir)));
  const layer = ServerSecretStoreLive.pipe(
    Layer.provide(config),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
}

const text = (value: string) => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);
const secretFile = (dir: string, name: string) => nodePath.join(dir, "secrets", `${name}.bin`);

describe("secrets encrypted at rest", () => {
  it("encrypts MCP secrets with the configured key and leaves other secrets alone", async () => {
    const dir = await stateDir();
    const key = Uint8Array.from(randomBytes(32));
    await run(
      dir,
      key,
      Effect.gen(function* () {
        const store = yield* ServerSecretStore;
        yield* store.set("mcp-secret-a", text("token-value"));
        yield* store.set("other-secret", text("plain-value"));
      }),
    );
    const onDisk = await readFile(secretFile(dir, "mcp-secret-a"));
    expect(isEncryptedSecretValue(onDisk)).toBe(true);
    expect(onDisk.includes(Buffer.from("token-value"))).toBe(false);
    // Windows has no POSIX modes.
    if (process.platform !== "win32")
      expect((await stat(secretFile(dir, "mcp-secret-a"))).mode & 0o777).toBe(0o600);
    expect((await readFile(secretFile(dir, "other-secret"))).toString()).toBe("plain-value");
    // With a configured key no fallback key file is written.
    await expect(stat(secretFile(dir, "secret-store-key"))).rejects.toThrow();
    const read = await run(
      dir,
      key,
      Effect.gen(function* () {
        return decode(yield* (yield* ServerSecretStore).get("mcp-secret-a"));
      }),
    );
    expect(read).toBe("token-value");
  });

  it("re-encrypts a plaintext secret the first time it is read", async () => {
    const dir = await stateDir();
    await run(
      dir,
      undefined,
      Effect.gen(function* () {
        yield* ServerSecretStore;
      }),
    );
    await writeFile(secretFile(dir, "mcp-oauth-x"), "legacy-token", { mode: 0o600 });
    const read = await run(
      dir,
      undefined,
      Effect.gen(function* () {
        return decode(yield* (yield* ServerSecretStore).get("mcp-oauth-x"));
      }),
    );
    expect(read).toBe("legacy-token");
    expect(isEncryptedSecretValue(await readFile(secretFile(dir, "mcp-oauth-x")))).toBe(true);
    // Headless: the key lives in a 0600 file in the secrets directory.
    if (process.platform !== "win32")
      expect((await stat(secretFile(dir, "secret-store-key"))).mode & 0o777).toBe(0o600);
  });

  it("never lets a read's migration overwrite a newer write", async () => {
    const dir = await stateDir();
    await run(
      dir,
      undefined,
      Effect.gen(function* () {
        yield* ServerSecretStore;
      }),
    );
    for (let round = 0; round < 20; round += 1) {
      await writeFile(secretFile(dir, "mcp-oauth-x"), "legacy-token", { mode: 0o600 });
      const final = await run(
        dir,
        undefined,
        Effect.gen(function* () {
          const store = yield* ServerSecretStore;
          yield* Effect.all([store.get("mcp-oauth-x"), store.set("mcp-oauth-x", text("newer"))], {
            concurrency: "unbounded",
          });
          return decode(yield* store.get("mcp-oauth-x"));
        }),
      );
      expect(final).toBe("newer");
    }
  });

  it.each(["mcp-secret-b", "mobile-apns-p8"])(
    "moves %s from the headless key file to the desktop key",
    async (name) => {
      const dir = await stateDir();
      await run(
        dir,
        undefined,
        Effect.gen(function* () {
          yield* (yield* ServerSecretStore).set(name, text("value-b"));
        }),
      );
      const before = await readFile(secretFile(dir, name));
      const desktopKey = Uint8Array.from(randomBytes(32));
      const read = await run(
        dir,
        desktopKey,
        Effect.gen(function* () {
          return decode(yield* (yield* ServerSecretStore).get(name));
        }),
      );
      expect(read).toBe("value-b");
      const after = await readFile(secretFile(dir, name));
      expect(after.equals(before)).toBe(false);
      // Nothing needs the key file any more, so the store removed it.
      await expect(stat(secretFile(dir, "secret-store-key"))).rejects.toThrow();
      expect(
        await run(
          dir,
          desktopKey,
          Effect.gen(function* () {
            return decode(yield* (yield* ServerSecretStore).get(name));
          }),
        ),
      ).toBe("value-b");
    },
  );

  it("refuses a value encrypted with another key or moved to another name", async () => {
    const dir = await stateDir();
    const key = Uint8Array.from(randomBytes(32));
    await run(
      dir,
      key,
      Effect.gen(function* () {
        yield* (yield* ServerSecretStore).set("mcp-secret-c", text("value-c"));
      }),
    );
    const wrongKey = run(
      dir,
      Uint8Array.from(randomBytes(32)),
      Effect.gen(function* () {
        return yield* (yield* ServerSecretStore).get("mcp-secret-c");
      }),
    );
    await expect(wrongKey).rejects.toThrow(/cannot be decrypted/);
    await writeFile(
      secretFile(dir, "mcp-secret-d"),
      await readFile(secretFile(dir, "mcp-secret-c")),
    );
    const swapped = run(
      dir,
      key,
      Effect.gen(function* () {
        return yield* (yield* ServerSecretStore).get("mcp-secret-d");
      }),
    );
    await expect(swapped).rejects.toThrow(/cannot be decrypted/);
  });

  it("parses only a 32-byte hex key", () => {
    expect(parseSecretStoreKey("ab".repeat(32))?.length).toBe(32);
    expect(parseSecretStoreKey("ab".repeat(31))).toBeUndefined();
    expect(parseSecretStoreKey(undefined)).toBeUndefined();
  });
});
