import type { AppUpdater } from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider";

// builder-util-runtime is not a direct dependency; derive its types from the provider.
type GithubOptions = ConstructorParameters<typeof GitHubProvider>[0];
type HttpRequestArgs = Parameters<GitHubProvider["httpRequest"]>;

/** Most feed entries a single beta check skips before reporting the failure. */
export const MAX_SKIPPED_FEED_TAGS = 3;

const CHANNEL_FILE_NOT_FOUND = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";

/**
 * The stock (electron-updater 6.8.3) GitHub provider resolves beta checks from the newest
 * qualifying `releases.atom` entry. That feed also lists bare tags, so a tag whose release
 * is still a draft (or has no release at all) captures every beta check: its channel files
 * return 404 and the check fails. This provider skips such entries and retries against
 * the remaining feed. Stable checks (`releases/latest`) and every other error are unchanged.
 */
export class F5GitHubProvider extends GitHubProvider {
  private readonly appUpdater: AppUpdater;
  private readonly skippedTags = new Set<string>();

  constructor(options: GithubOptions, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    super(options, updater, runtimeOptions);
    this.appUpdater = updater;
  }

  override async getLatestVersion(): ReturnType<GitHubProvider["getLatestVersion"]> {
    this.skippedTags.clear();
    try {
      for (;;) {
        try {
          return await super.getLatestVersion();
        } catch (error) {
          const tag = this.skippableTag(error);
          if (tag === null) throw error;
          this.skippedTags.add(tag);
          this.appUpdater.logger?.warn(
            `Skipping update feed entry ${tag}: its update files are not published.`,
          );
        }
      }
    } finally {
      this.skippedTags.clear();
    }
  }

  protected override async httpRequest(...args: HttpRequestArgs): Promise<string | null> {
    const [url] = args;
    const body = await super.httpRequest(...args);
    if (body === null || this.skippedTags.size === 0 || !url.pathname.endsWith(".atom"))
      return body;
    return withoutFeedEntries(body, this.skippedTags);
  }

  private skippableTag(error: unknown): string | null {
    if (!this.appUpdater.allowPrerelease) return null;
    if ((error as { code?: unknown } | null)?.code !== CHANNEL_FILE_NOT_FOUND) return null;
    if (this.skippedTags.size >= MAX_SKIPPED_FEED_TAGS) return null;
    const tag = channelFileTag(String((error as Error).message));
    return tag !== null && !this.skippedTags.has(tag) ? tag : null;
  }
}

/** The release tag named by a channel file URL in an electron-updater error message. */
export function channelFileTag(message: string): string | null {
  const match = /\/releases\/download\/([^/\s)]+)\//.exec(message);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/** Removes the Atom `<entry>` blocks whose release tag link is in `tags`. */
export function withoutFeedEntries(feed: string, tags: ReadonlySet<string>): string {
  return feed.replace(/<entry\b[\s\S]*?<\/entry>/g, (entry) => {
    const tag = /\/releases\/tag\/([^"'<>\s]+)/.exec(entry)?.[1];
    if (tag === undefined) return entry;
    try {
      return tags.has(decodeURIComponent(tag)) ? "" : entry;
    } catch {
      return entry;
    }
  });
}

export interface F5GitHubFeedOptions {
  readonly provider: "custom";
  readonly updateProvider: typeof F5GitHubProvider;
  readonly owner: string;
  readonly repo: string;
  readonly host?: string;
  readonly protocol?: "https" | "http";
}

/**
 * Feed options for `autoUpdater.setFeedURL` from the packaged `app-update.yml` (the flat
 * YAML electron-builder writes). Returns null unless it names a public GitHub feed, so
 * other providers keep stock behaviour. Windows signature checks keep reading
 * `publisherName` from the on-disk config, not from these options.
 */
export function f5GitHubFeedOptions(appUpdateYml: string): F5GitHubFeedOptions | null {
  const values = new Map<string, string>();
  for (const line of appUpdateYml.split(/\r?\n/)) {
    const entry = /^([A-Za-z][\w-]*):\s+(.+)$/.exec(line);
    if (entry) values.set(entry[1]!, unquote(entry[2]!.trim()));
  }
  const owner = values.get("owner");
  const repo = values.get("repo");
  if (values.get("provider") !== "github" || !owner || !repo) return null;
  if (values.get("private") === "true" || values.has("token")) return null;
  const host = values.get("host");
  const protocol = values.get("protocol");
  return {
    provider: "custom",
    updateProvider: F5GitHubProvider,
    owner,
    repo,
    ...(host ? { host } : {}),
    ...(protocol === "https" || protocol === "http" ? { protocol } : {}),
  };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value;
    }
  }
  return value;
}
