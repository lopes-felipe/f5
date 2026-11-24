import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { GitHubProvider as ProviderType } from "electron-updater/out/providers/GitHubProvider";
const require = createRequire(import.meta.url);
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider") as {
  GitHubProvider: typeof ProviderType;
};
const { HttpError } = createRequire(require.resolve("electron-updater"))(
  "builder-util-runtime",
) as { HttpError: new (response: unknown) => Error };
// Versions get the app's `v` prefix; `raw:` entries are other releases' tags, verbatim.
const tagName = (tag: string) => (tag.startsWith("raw:") ? tag.slice(4) : `v${tag}`);
async function select(tags: string[], beta: boolean, fallback = false) {
  const requests: string[] = [];
  const updater = {
    channel: beta ? "beta" : "latest",
    allowPrerelease: beta,
    currentVersion: "0.1.0",
    fullChangelog: false,
  };
  const provider = new GitHubProvider(
    { provider: "github", owner: "lopes-felipe", repo: "f5" },
    updater as never,
    {
      platform: "darwin",
      isUseMultipleRangeRequest: false,
      executor: {
        request: async (options: { path: string }) => {
          const path = options.path;
          requests.push(path);
          if (path.endsWith(".atom"))
            return `<feed>${tags.map((tag) => `<entry><link href="https://github.com/lopes-felipe/f5/releases/tag/${tagName(tag)}"/><title>${tag}</title><content>Notes</content></entry>`).join("")}</feed>`;
          if (path.endsWith("/latest"))
            return JSON.stringify({ tag_name: `v${tags.find((tag) => !tag.includes("-"))}` });
          if (fallback && path.endsWith("beta-mac.yml"))
            throw new HttpError({ statusCode: 404, statusMessage: "Not Found", headers: {} });
          const version = /\/v([^/]+)\//.exec(path)?.[1];
          return `version: ${version}\nfiles:\n  - url: F5.zip\n    sha512: hash\n    size: 1\npath: F5.zip\nsha512: hash\nreleaseDate: '2026-01-01T00:00:00Z'\n`;
        },
      } as never,
    },
  );
  return { info: await provider.getLatestVersion(), requests };
}
describe("pinned GitHub provider feed order", () => {
  it("selects beta through beta-mac.yml", async () => {
    const r = await select(["0.3.0-beta.1", "0.2.0"], true);
    expect(r.info.version).toBe("0.3.0-beta.1");
    expect(r.requests.at(-1)).toContain("beta-mac.yml");
  });
  it("falls back to latest for stable", async () => {
    const r = await select(["0.2.0"], true, true);
    expect(r.info.version).toBe("0.2.0");
    expect(r.requests.at(-1)).toContain("latest-mac.yml");
  });
  it("documents unsupported lower-hotfix feed order despite a higher beta", async () => {
    expect((await select(["0.2.1", "0.3.0-beta.1"], true)).info.version).toBe("0.2.1");
  });
  it("skips preview suffixes", async () => {
    expect(
      (await select(["0.4.0-computer-use-preview.1", "0.3.0-beta.1"], true)).info.version,
    ).toBe("0.3.0-beta.1");
  });
  it("skips VM guest image releases, which use a custom-channel semver tag", async () => {
    const r = await select(["raw:0.0.0-guest-image-bfde204f134b", "0.3.0-beta.1"], true);
    expect(r.info.version).toBe("0.3.0-beta.1");
    expect(r.requests.some((p) => p.includes("guest-image"))).toBe(false);
  });
  it("documents that a non-semver tag on top of the feed captures beta checks", async () => {
    // Why guest image tags can't be plain `guest-image-<commit>`: the beta check would look
    // for beta-mac.yml and latest-mac.yml in that release and fail.
    const r = await select(["raw:guest-image-bfde204f134b", "0.3.0-beta.1"], true);
    expect(r.info.tag).toBe("guest-image-bfde204f134b");
  });
  it("stable resolves releases/latest", async () => {
    const r = await select(["0.3.0-beta.1", "0.2.0"], false);
    expect(r.requests.some((p) => p.endsWith("/releases/latest"))).toBe(true);
    expect(r.info.version).toBe("0.2.0");
  });
});
