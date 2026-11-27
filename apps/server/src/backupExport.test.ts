import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { encryptSecretValue } from "./auth/secretStoreKey.ts";
import { exportableSecrets } from "./backupExport.ts";

describe("backup secrets", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("exports values encrypted at rest as plain values a restore can re-encrypt", async () => {
    const secretsDir = await mkdtemp(join(tmpdir(), "f5-backup-secrets-"));
    const stagingDir = await mkdtemp(join(tmpdir(), "f5-backup-staging-"));
    dirs.push(secretsDir, stagingDir);
    const key = randomBytes(32);
    const plain = new TextEncoder().encode('{"tokens":{"access_token":"at"}}');
    const encrypted = join(secretsDir, "mcp-oauth-abc.bin");
    await writeFile(encrypted, encryptSecretValue(key, "mcp-oauth-abc", plain));
    const other = join(secretsDir, "server-signing-key.bin");
    await writeFile(other, "raw");

    const copies = await exportableSecrets(secretsDir, stagingDir, key.toString("base64"));
    expect([...copies.keys()]).toEqual([encrypted]);
    expect(new Uint8Array(await readFile(copies.get(encrypted)!))).toEqual(plain);

    // Without the key the value cannot be read, so it is exported as stored.
    expect((await exportableSecrets(secretsDir, stagingDir, undefined)).size).toBe(0);
  });
});
