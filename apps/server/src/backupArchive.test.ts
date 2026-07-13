import { gunzipSync } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseBackupArchive, writeBackupArchive } from "./backupArchive.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "f5-backup-archive-"));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("F5 backup archive", () => {
  it("round-trips checksummed files and decrypts explicitly included secrets", async () => {
    const root = await tempDir();
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "database.sqlite"), "database-state");
    await writeFile(join(source, "attachment.txt"), "attachment-state");
    await writeFile(join(source, "credential.json"), "super-secret-credential");
    const archive = join(root, "backup.f5backup");

    const manifest = await writeBackupArchive({
      output: createWriteStream(archive),
      appVersion: "test",
      password: "correct horse battery staple",
      entries: [
        {
          archivePath: "database.sqlite",
          sourcePath: join(source, "database.sqlite"),
          encrypt: false,
        },
        {
          archivePath: "attachments/attachment.txt",
          sourcePath: join(source, "attachment.txt"),
          encrypt: false,
        },
        {
          archivePath: "secrets/credential.json",
          sourcePath: join(source, "credential.json"),
          encrypt: true,
        },
      ],
    });

    expect(manifest.version).toBe(1);
    expect(manifest.encryption?.algorithm).toBe("aes-256-gcm");
    expect(gunzipSync(await readFile(archive)).includes("super-secret-credential")).toBe(false);

    const restored = await parseBackupArchive({
      source: createReadStream(archive),
      stagingDir: join(root, "restore"),
      password: "correct horse battery staple",
    });
    expect(await readFile(join(restored.payloadDir, "database.sqlite"), "utf8")).toBe(
      "database-state",
    );
    expect(await readFile(join(restored.payloadDir, "attachments/attachment.txt"), "utf8")).toBe(
      "attachment-state",
    );
    expect(await readFile(join(restored.payloadDir, "secrets/credential.json"), "utf8")).toBe(
      "super-secret-credential",
    );
  });

  it("rejects an incorrect password before staging secret plaintext", async () => {
    const root = await tempDir();
    await writeFile(join(root, "database.sqlite"), "database-state");
    await writeFile(join(root, "secret"), "credential");
    const archive = join(root, "backup.f5backup");
    await writeBackupArchive({
      output: createWriteStream(archive),
      appVersion: "test",
      password: "correct horse battery staple",
      entries: [
        {
          archivePath: "database.sqlite",
          sourcePath: join(root, "database.sqlite"),
          encrypt: false,
        },
        { archivePath: "secrets/token", sourcePath: join(root, "secret"), encrypt: true },
      ],
    });

    await expect(
      parseBackupArchive({
        source: createReadStream(archive),
        stagingDir: join(root, "wrong-password"),
        password: "this password is wrong",
      }),
    ).rejects.toThrow("Unable to decrypt backup secrets");
  });

  it("enforces compressed upload and combined temporary-storage limits", async () => {
    const root = await tempDir();
    const databaseState = "database-state";
    await writeFile(join(root, "database.sqlite"), databaseState);
    const archive = join(root, "backup.f5backup");
    await writeBackupArchive({
      output: createWriteStream(archive),
      appVersion: "test",
      entries: [
        {
          archivePath: "database.sqlite",
          sourcePath: join(root, "database.sqlite"),
          encrypt: false,
        },
      ],
    });
    const compressed = await readFile(archive);
    const decompressed = gunzipSync(compressed);

    await expect(
      writeBackupArchive({
        output: createWriteStream(join(root, "oversized-export.f5backup")),
        appVersion: "test",
        maxArchiveBytes: 1,
        entries: [
          {
            archivePath: "database.sqlite",
            sourcePath: join(root, "database.sqlite"),
            encrypt: false,
          },
        ],
      }),
    ).rejects.toThrow("configured export size limit");

    await expect(
      parseBackupArchive({
        source: createReadStream(archive),
        stagingDir: join(root, "compressed-limit"),
        limits: {
          maxCompressedBytes: compressed.length - 1,
          maxDecompressedBytes: decompressed.length + 1,
          maxTemporaryBytes: decompressed.length * 3,
          maxExpansionRatio: 1_000,
          minFreeBytes: 1,
        },
      }),
    ).rejects.toThrow("compressed restore size limit");

    await expect(
      parseBackupArchive({
        source: createReadStream(archive),
        stagingDir: join(root, "temporary-limit"),
        limits: {
          maxCompressedBytes: compressed.length + 1,
          maxDecompressedBytes: decompressed.length + 1,
          maxTemporaryBytes: decompressed.length + Buffer.byteLength(databaseState) - 1,
          maxExpansionRatio: 1_000,
          minFreeBytes: 1,
        },
      }),
    ).rejects.toThrow("temporary restore storage limit");
  });
});
