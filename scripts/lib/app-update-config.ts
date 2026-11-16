/** Production update feed baked into every versioned desktop build. */
export const RELEASE_UPDATE_OWNER = "lopes-felipe";
export const RELEASE_UPDATE_REPO = "f5";
export const RELEASE_UPDATE_REPOSITORY = `${RELEASE_UPDATE_OWNER}/${RELEASE_UPDATE_REPO}`;

type AppUpdateValue = string | string[];

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return JSON.parse(value) as string;
  return value;
}

/** Parses the flat YAML electron-builder 26.15.3 writes to `resources/app-update.yml`. */
export function parseAppUpdateConfig(text: string): Record<string, AppUpdateValue> {
  const config: Record<string, AppUpdateValue> = {};
  let listKey: string | null = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && listKey) {
      (config[listKey] as string[]).push(unquote(item[1]!.trim()));
      continue;
    }
    const entry = /^([A-Za-z][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (!entry) throw new Error(`Invalid app-update.yml line ${index + 1}: ${line}`);
    const [, key, raw] = entry as unknown as [string, string, string | undefined];
    if (key in config) throw new Error(`Duplicate app-update.yml key: ${key}`);
    if (raw === undefined || raw.trim() === "") {
      config[key] = [];
      listKey = key;
    } else {
      config[key] = unquote(raw.trim());
      listKey = null;
    }
  }
  return config;
}

/**
 * Packaged builds must point at the production GitHub feed. Unsigned builds carry
 * no publisherName (electron-updater then skips signature checks); signed builds
 * carry exactly the expected signer.
 */
export function verifyAppUpdateConfig(
  text: string,
  expected: { readonly channel: string; readonly publisherName?: string | undefined },
): void {
  const config = parseAppUpdateConfig(text);
  const require = (key: string, value: string) => {
    if (config[key] !== value)
      throw new Error(
        `app-update.yml ${key} must be ${value}, found ${JSON.stringify(config[key])}`,
      );
  };
  require("provider", "github");
  require("owner", RELEASE_UPDATE_OWNER);
  require("repo", RELEASE_UPDATE_REPO);
  require("releaseType", "release");
  require("channel", expected.channel);
  for (const key of ["host", "protocol", "token", "private"])
    if (key in config) throw new Error(`app-update.yml must not override ${key}`);
  const publisher = config.publisherName;
  if (expected.publisherName === undefined) {
    if (publisher !== undefined)
      throw new Error("Unsigned builds must not embed an update publisherName");
    return;
  }
  const names = typeof publisher === "string" ? [publisher] : (publisher ?? []);
  if (names.length !== 1 || names[0] !== expected.publisherName)
    throw new Error(
      `app-update.yml publisherName must be ${expected.publisherName}, found ${JSON.stringify(publisher)}`,
    );
}
