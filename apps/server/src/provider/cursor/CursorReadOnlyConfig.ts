/**
 * Keeps Cursor's own approval settings from letting commands past F5 in read-only workflow
 * stages. Cursor's ACP server runs no sandbox (docs/reviews/cursor-live-gates.md), so F5's
 * command policy is the only control, and it only sees commands Cursor asks about. Cursor runs
 * these without asking:
 *
 * - commands on `permissions.allow` in `cli-config.json`, or on `terminalAllowlist` in
 *   `permissions.json`, both in the CLI's config dir;
 * - every command when `approvalMode` is `unrestricted` or `auto-review`;
 * - the same settings from any `.cursor/cli.json` between the repository root and the working
 *   directory, which the CLI merges into the user's config.
 *
 * Read-only sessions therefore start with `CURSOR_CONFIG_DIR` pointing at an F5-owned copy of
 * `cli-config.json` with an empty allowlist and `approvalMode: "allowlist"`, and no
 * `permissions.json`. Sign-in doesn't move: the CLI keeps credentials in the keychain or
 * `auth.json` under HOME, `XDG_CONFIG_HOME` or `APPDATA`, never in `CURSOR_CONFIG_DIR`. A
 * repository whose `.cursor/cli.json` loosens approvals is refused, because F5 can't override it.
 * Team admin allowlists are applied server-side and stay out of F5's reach.
 */
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

/** The config dir the Cursor CLI reads, resolved the way the CLI resolves it. */
export function cursorCliConfigDir(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.CURSOR_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  const xdg = environment.XDG_CONFIG_HOME?.trim();
  if (xdg) return nodePath.join(xdg, "cursor");
  const home =
    (process.platform === "win32" ? environment.USERPROFILE : environment.HOME)?.trim() ||
    nodeOs.homedir();
  return nodePath.join(home, ".cursor");
}

export function cursorReadOnlyConfigDir(providerHomesDir: string, instanceId: string): string {
  return nodePath.join(providerHomesDir, "cursor-readonly", instanceId);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A `cli-config.json` with every setting that lets a command run without asking turned off. */
export function sanitizeCursorCliConfig(config: unknown): Record<string, unknown> {
  const base = isRecord(config) ? config : {};
  const permissions = isRecord(base.permissions) ? base.permissions : {};
  return {
    ...base,
    // Deny rules only ever refuse more, so they stay.
    permissions: { allow: [], deny: Array.isArray(permissions.deny) ? permissions.deny : [] },
    approvalMode: "allowlist",
  };
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await nodeFs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Writes the read-only config dir and returns the environment to launch Cursor with. The copy is
 * rewritten on every start, so a setting the CLI saved into it during an earlier session doesn't
 * outlive that session.
 */
export async function prepareCursorReadOnlyEnvironment(input: {
  readonly providerHomesDir: string;
  readonly instanceId: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  const directory = cursorReadOnlyConfigDir(input.providerHomesDir, input.instanceId);
  const source = cursorCliConfigDir(input.environment);
  const config =
    nodePath.resolve(source) === nodePath.resolve(directory)
      ? undefined
      : await readJson(nodePath.join(source, "cli-config.json"));
  await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
  await nodeFs.rm(nodePath.join(directory, "permissions.json"), { force: true });
  const target = nodePath.join(directory, "cli-config.json");
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await nodeFs.writeFile(
    temporary,
    `${JSON.stringify(sanitizeCursorCliConfig(config), null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await nodeFs.rename(temporary, target);
  return { ...input.environment, CURSOR_CONFIG_DIR: directory };
}

/**
 * The first `.cursor/cli.json` from `cwd` up to the filesystem root that would let commands run
 * without asking F5, or undefined. The CLI reads these from the repository root down to the
 * working directory; checking every ancestor covers that without finding the root. A file that
 * isn't valid JSON is skipped, as the CLI skips it.
 */
export async function findPermissiveCursorProjectConfig(cwd: string): Promise<string | undefined> {
  let directory = nodePath.resolve(cwd);
  for (;;) {
    const file = nodePath.join(directory, ".cursor", "cli.json");
    const config = await readJson(file).catch(() => undefined);
    if (isRecord(config)) {
      const allow = isRecord(config.permissions) ? config.permissions.allow : undefined;
      const loosensApproval =
        config.approvalMode !== undefined && config.approvalMode !== "allowlist";
      const allows = allow !== undefined && !(Array.isArray(allow) && allow.length === 0);
      if (loosensApproval || allows) return file;
    }
    const parent = nodePath.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
