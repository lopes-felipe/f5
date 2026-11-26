import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  channelFileTag,
  F5GitHubProvider,
  f5GitHubFeedOptions,
  withoutFeedEntries,
} from "./updateGitHubProvider";

const require = createRequire(import.meta.url);
const { HttpError } = createRequire(require.resolve("electron-updater"))(
  "builder-util-runtime",
) as { HttpError: new (statusCode: number, message?: string) => Error };

/**
 * `missing` tags 404 both channel files (a draft or bare tag); `failing` tags return 500;
 * `betaOnly` tags return 500 for `beta-mac.yml` and 404 for `latest-mac.yml` (a healthy beta
 * release that ships only beta channel files, hit by a transient error).
 */
function fixture(
  tags: string[],
  options: {
    beta: boolean;
    missing?: string[];
    failing?: string[];
    network?: string[];
    betaOnly?: string[];
  },
) {
  const requests: string[] = [];
  const state = { missing: new Set(options.missing ?? []) };
  const warnings: string[] = [];
  const updater = {
    channel: options.beta ? "beta" : "latest",
    allowPrerelease: options.beta,
    currentVersion: "0.1.12-beta.40",
    fullChangelog: false,
    logger: { info: () => {}, warn: (message: string) => warnings.push(message), error: () => {} },
  };
  const provider = new F5GitHubProvider(
    { provider: "github", owner: "lopes-felipe", repo: "f5" },
    updater as never,
    {
      platform: "darwin",
      isUseMultipleRangeRequest: false,
      executor: {
        request: async (request: { path: string }) => {
          const path = request.path;
          requests.push(path);
          if (path.endsWith(".atom"))
            return `<feed><title>Release notes from f5</title>${tags
              .map(
                (tag) =>
                  `<entry><id>${tag}</id><link rel="alternate" type="text/html" href="https://github.com/lopes-felipe/f5/releases/tag/${tag}"/><title>${tag}</title><content>Notes</content></entry>`,
              )
              .join("")}</feed>`;
          if (path.endsWith("/latest"))
            return JSON.stringify({ tag_name: tags.find((tag) => !tag.includes("-")) });
          const tag = /\/download\/([^/]+)\//.exec(path)?.[1] ?? "";
          if (state.missing.has(tag)) throw new HttpError(404, "Not Found");
          if (options.failing?.includes(tag)) throw new HttpError(500, "Server Error");
          if (options.network?.includes(tag)) throw new Error("socket hang up");
          if (options.betaOnly?.includes(tag))
            throw path.endsWith("/beta-mac.yml")
              ? new HttpError(500, "Server Error")
              : new HttpError(404, "Not Found");
          const version = tag.slice(1);
          return `version: ${version}\nfiles:\n  - url: F5-${version}-arm64.zip\n    sha512: hash\n    size: 1\npath: F5-${version}-arm64.zip\nsha512: hash\nreleaseDate: '2026-01-01T00:00:00Z'\n`;
        },
      } as never,
    },
  );
  return { provider, requests, state, warnings };
}
const yml = (requests: string[]) => requests.filter((path) => path.endsWith(".yml"));

describe("F5GitHubProvider beta feed fallback", () => {
  it("skips a draft's bare tag on top of the feed and resolves the next release", async () => {
    const { provider, requests, warnings } = fixture(
      ["v0.1.14-beta.6", "v0.1.13", "v0.1.12-beta.47"],
      { beta: true, missing: ["v0.1.14-beta.6"] },
    );
    const info = await provider.getLatestVersion();
    expect(info.tag).toBe("v0.1.13");
    expect(info.version).toBe("0.1.13");
    expect(provider.resolveFiles(info)[0]!.url.pathname).toBe(
      "/lopes-felipe/f5/releases/download/v0.1.13/F5-0.1.13-arm64.zip",
    );
    expect(yml(requests)).toEqual([
      "/lopes-felipe/f5/releases/download/v0.1.14-beta.6/beta-mac.yml",
      "/lopes-felipe/f5/releases/download/v0.1.14-beta.6/latest-mac.yml",
      "/lopes-felipe/f5/releases/download/v0.1.13/beta-mac.yml",
    ]);
    expect(warnings).toEqual([
      "Skipping update feed entry v0.1.14-beta.6: its update files are not published.",
    ]);
  });
  it("skips consecutive unpublished entries", async () => {
    const { provider } = fixture(["v0.1.14-beta.7", "v0.1.14-beta.6", "v0.1.14-beta.5"], {
      beta: true,
      missing: ["v0.1.14-beta.7", "v0.1.14-beta.6"],
    });
    expect((await provider.getLatestVersion()).tag).toBe("v0.1.14-beta.5");
  });
  it("gives up after three skipped entries with the stock error", async () => {
    const tags = ["v0.1.14-beta.9", "v0.1.14-beta.8", "v0.1.14-beta.7", "v0.1.14-beta.6"];
    const { provider } = fixture([...tags, "v0.1.13"], { beta: true, missing: tags });
    await expect(provider.getLatestVersion()).rejects.toMatchObject({
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      message: expect.stringContaining("/download/v0.1.14-beta.6/"),
    });
  });
  it.each([
    ["server errors", { failing: ["v0.1.14-beta.6"] }],
    ["network failures", { network: ["v0.1.14-beta.6"] }],
  ])("rethrows %s without skipping", async (_name, failure) => {
    const { provider, requests } = fixture(["v0.1.14-beta.6", "v0.1.13"], {
      beta: true,
      ...failure,
    });
    await expect(provider.getLatestVersion()).rejects.not.toMatchObject({
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    expect(requests.some((path) => path.includes("/v0.1.13/"))).toBe(false);
    expect(requests.filter((path) => path.endsWith(".atom"))).toHaveLength(1);
  });
  it("never skips a release whose beta channel file failed transiently before the 404 fallback", async () => {
    const { provider, requests, warnings } = fixture(["v0.1.14-beta.7", "v0.1.14-beta.6"], {
      beta: true,
      betaOnly: ["v0.1.14-beta.7"],
    });
    await expect(provider.getLatestVersion()).rejects.toMatchObject({
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
      message: expect.stringContaining("/download/v0.1.14-beta.7/"),
    });
    expect(requests.some((path) => path.includes("/v0.1.14-beta.6/"))).toBe(false);
    expect(warnings).toEqual([]);
  });
  it("leaves stable checks unchanged", async () => {
    const { provider, requests } = fixture(["v0.1.14-beta.6", "v0.1.13", "v0.1.12"], {
      beta: false,
      missing: ["v0.1.13"],
    });
    await expect(provider.getLatestVersion()).rejects.toMatchObject({
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    expect(requests.filter((path) => path.endsWith(".atom"))).toHaveLength(1);
  });
  it("starts every check with an empty skip set", async () => {
    const { provider, state } = fixture(["v0.1.14-beta.6", "v0.1.13"], {
      beta: true,
      missing: ["v0.1.14-beta.6"],
    });
    expect((await provider.getLatestVersion()).tag).toBe("v0.1.13");
    // The draft is published between checks.
    state.missing.clear();
    expect((await provider.getLatestVersion()).tag).toBe("v0.1.14-beta.6");
  });
});

describe("feed helpers", () => {
  it("reads the tag from a channel file error", () => {
    expect(
      channelFileTag(
        "Cannot find latest-mac.yml in the latest release artifacts (https://github.com/lopes-felipe/f5/releases/download/v0.1.14-beta.6/latest-mac.yml): HttpError: 404",
      ),
    ).toBe("v0.1.14-beta.6");
    expect(channelFileTag("No published versions on GitHub")).toBeNull();
  });
  it("removes only the skipped entries", () => {
    const feed =
      '<feed><entry><link href="https://github.com/o/r/releases/tag/v2"/></entry>' +
      '<entry><link href="https://github.com/o/r/releases/tag/v1"/></entry></feed>';
    expect(withoutFeedEntries(feed, new Set(["v2"]))).toBe(
      '<feed><entry><link href="https://github.com/o/r/releases/tag/v1"/></entry></feed>',
    );
  });
  it("builds custom feed options only for a public GitHub app-update.yml", () => {
    const yml =
      "owner: lopes-felipe\nrepo: f5\nprovider: github\nupdaterCacheDirName: f5-updater\npublisherName:\n  - Felipe\n";
    expect(f5GitHubFeedOptions(yml)).toEqual({
      provider: "custom",
      updateProvider: F5GitHubProvider,
      owner: "lopes-felipe",
      repo: "f5",
    });
    expect(f5GitHubFeedOptions("provider: generic\nurl: https://example.com\n")).toBeNull();
    expect(f5GitHubFeedOptions(yml + "private: true\n")).toBeNull();
    expect(f5GitHubFeedOptions("provider: github\nowner: o\n")).toBeNull();
  });
});
