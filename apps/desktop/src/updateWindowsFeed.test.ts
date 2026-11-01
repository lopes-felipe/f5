import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubProvider as ProviderType } from "electron-updater/out/providers/GitHubProvider";
import type { NsisUpdater as NsisType } from "electron-updater/out/NsisUpdater";
const require = createRequire(import.meta.url);
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider") as {
  GitHubProvider: typeof ProviderType;
};
const { NsisUpdater } = require("electron-updater/out/NsisUpdater") as {
  NsisUpdater: typeof NsisType;
};
const { DigestTransform, HttpError } = createRequire(require.resolve("electron-updater"))(
  "builder-util-runtime",
) as {
  DigestTransform: new (expected: string) => NodeJS.ReadWriteStream;
  HttpError: new (response: unknown) => Error;
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function resolveStable(
  options: Record<string, unknown> = {},
  clientChannel = "latest",
  currentVersion = "0.1.0",
) {
  const requests: string[] = [];
  const provider = new GitHubProvider(
    { provider: "github", owner: "lopes-felipe", repo: "f5", ...options },
    {
      channel: clientChannel,
      allowPrerelease: clientChannel === "beta",
      currentVersion,
      fullChangelog: true,
    } as never,
    {
      platform: "win32",
      isUseMultipleRangeRequest: false,
      executor: {
        request: async ({ path }: { path: string }) => {
          requests.push(path);
          if (path.endsWith(".atom"))
            return `<feed><entry><link href="https://github.com/lopes-felipe/f5/releases/tag/v0.1.1"/><title>0.1.1</title><content>Notes</content></entry></feed>`;
          if (path.endsWith("/latest")) return JSON.stringify({ tag_name: "v0.1.1" });
          if (path.endsWith("/beta.yml"))
            throw new HttpError({ statusCode: 404, statusMessage: "Not Found", headers: {} });
          return `version: 0.1.1\nfiles:\n  - url: F5-0.1.1-x64.exe\n    sha512: hash\n    size: 1\npath: F5-0.1.1-x64.exe\nsha512: hash\nreleaseDate: '2026-10-17T00:00:00Z'\n`;
        },
      } as never,
    },
  );
  return { info: await provider.getLatestVersion(), requests };
}

describe("pinned Windows stable feed", () => {
  it("upgrades beta clients to a stable release through its real latest.yml fallback", async () => {
    const { info, requests } = await resolveStable(
      { host: "127.0.0.1:4321", protocol: "http" },
      "beta",
      "0.1.1-beta.2",
    );
    expect(info.version).toBe("0.1.1");
    expect(requests).toEqual([
      "/lopes-felipe/f5/releases.atom",
      "/lopes-felipe/f5/releases/download/v0.1.1/beta.yml",
      "/lopes-felipe/f5/releases/download/v0.1.1/latest.yml",
    ]);
  });
  it("resolves /releases/latest and reads latest.yml from that release", async () => {
    const { info, requests } = await resolveStable();
    expect(info.version).toBe("0.1.1");
    expect(info.files[0]?.url).toBe("F5-0.1.1-x64.exe");
    expect(requests).toEqual([
      "/lopes-felipe/f5/releases.atom",
      "/lopes-felipe/f5/releases/latest",
      "/lopes-felipe/f5/releases/download/v0.1.1/latest.yml",
    ]);
  });
  it("uses the GitHub Enterprise paths the loopback rehearsal emulator serves", async () => {
    const { requests } = await resolveStable({ host: "127.0.0.1:4321", protocol: "http" });
    expect(requests).toEqual([
      "/lopes-felipe/f5/releases.atom",
      "/api/v3/repos/lopes-felipe/f5/releases/latest",
      "/lopes-felipe/f5/releases/download/v0.1.1/latest.yml",
    ]);
  });
});

describe("pinned NSIS signature verification", () => {
  function updater(config: string) {
    const root = mkdtempSync(join(tmpdir(), "f5-nsis-"));
    roots.push(root);
    writeFileSync(join(root, "app-update.yml"), config);
    const nsis = new NsisUpdater(null, { version: "0.1.0", quit: vi.fn() } as never);
    nsis.logger = null;
    nsis.updateConfigPath = join(root, "app-update.yml");
    const verifier = vi.fn(async () => "signature rejected");
    nsis.verifyUpdateCodeSignature = verifier;
    const verify = (file: string) =>
      (
        nsis as unknown as { verifySignature(file: string): Promise<string | null> }
      ).verifySignature(file);
    return { verify, verifier };
  }
  const feed = "owner: lopes-felipe\nrepo: f5\nprovider: github\nchannel: latest\n";

  it("accepts unsigned and later signed installers when no publisherName is embedded", async () => {
    const { verify, verifier } = updater(feed);
    await expect(verify("F5-0.1.1-x64.exe")).resolves.toBeNull();
    expect(verifier).not.toHaveBeenCalled();
  });
  it("verifies every update once a signed build embeds publisherName", async () => {
    const { verify, verifier } = updater(`${feed}publisherName:\n  - F5 Publisher\n`);
    await expect(verify("F5-0.1.2-x64.exe")).resolves.toBe("signature rejected");
    expect(verifier).toHaveBeenCalledWith(["F5 Publisher"], "F5-0.1.2-x64.exe");
  });
});

describe("pinned download checksum validation", () => {
  const sink = () =>
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  it("rejects a payload whose sha512 differs from latest.yml", async () => {
    const expected = Buffer.alloc(64).toString("base64");
    await expect(
      pipeline(Readable.from([Buffer.from("payload")]), new DigestTransform(expected), sink()),
    ).rejects.toMatchObject({ code: "ERR_CHECKSUM_MISMATCH" });
  });
  it("accepts the matching sha512", async () => {
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha512").update("payload").digest("base64");
    await pipeline(Readable.from([Buffer.from("payload")]), new DigestTransform(expected), sink());
  });
});
