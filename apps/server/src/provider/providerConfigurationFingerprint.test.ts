import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  executionProviderFingerprint,
  executionProviderFingerprintFor,
} from "./providerConfigurationFingerprint.ts";
describe("scheduled recovery execution identity", () => {
  it("ignores cosmetic settings and object field order", () => {
    const base = {
      driver: ProviderDriverKind.make("codex"),
      config: { binaryPath: "/bin/codex", home: "/tmp/account" },
    };
    expect(executionProviderFingerprint(base)).toBe(
      executionProviderFingerprint({
        ...base,
        displayName: "New label",
        accentColor: "blue",
        config: { home: "/tmp/account", binaryPath: "/bin/codex" },
      }),
    );
    expect(executionProviderFingerprint(base)).not.toBe(
      executionProviderFingerprint({ ...base, config: { home: "/tmp/other-account" } }),
    );
  });
  it("detects credential changes without persisting raw sensitive values", () => {
    const base = {
      driver: ProviderDriverKind.make("codex"),
      environment: [{ name: "SECRET", value: "original-secret", sensitive: true }],
    };
    const fingerprint = executionProviderFingerprint(base);
    expect(fingerprint).not.toContain("original-secret");
    expect(fingerprint).toBe(executionProviderFingerprint(base));
    expect(fingerprint).not.toBe(
      executionProviderFingerprint({
        ...base,
        environment: [{ name: "SECRET", value: "changed-secret", sensitive: true }],
      }),
    );
  });
});

it("requires protected storage for sensitive persisted identities", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      executionProviderFingerprintFor({
        driver: ProviderDriverKind.make("codex"),
        environment: [{ name: "SECRET", value: "guessable", sensitive: true }],
      }),
    ),
  );
  expect(result._tag).toBe("Failure");
});

it("preserves protected execution fingerprints across independent server processes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "f5-durable-fingerprint-"));
  const fingerprintModule = path.resolve(
    import.meta.dirname,
    "providerConfigurationFingerprint.ts",
  );
  const configModule = path.resolve(import.meta.dirname, "../config.ts");
  const storeModule = path.resolve(import.meta.dirname, "../auth/Layers/ServerSecretStore.ts");
  const script = `
    import { Effect, Layer } from "effect";
    import * as NodeServices from "@effect/platform-node/NodeServices";
    import { ServerConfig } from ${JSON.stringify(configModule)};
    import { ServerSecretStoreLive } from ${JSON.stringify(storeModule)};
    import { executionProviderFingerprintFor } from ${JSON.stringify(fingerprintModule)};
    const layer = ServerSecretStoreLive.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), ${JSON.stringify(directory)})), Layer.provide(NodeServices.layer));
    const fingerprint = await Effect.runPromise(Effect.scoped(executionProviderFingerprintFor({ driver: "codex", environment: [{ name: "SECRET", value: "guessable-secret", sensitive: true }] }).pipe(Effect.provide(layer))));
    process.stdout.write(fingerprint);
  `;
  try {
    const run = () =>
      promisify(execFile)("bun", ["-e", script], {
        cwd: path.resolve(import.meta.dirname, "../.."),
      });
    const first = (await run()).stdout;
    const second = (await run()).stdout;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    const secret = path.join(directory, "secrets", "usage-resume-fingerprint-key.bin");
    expect((await readFile(secret)).length).toBe(32);
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
