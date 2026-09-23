import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { Effect } from "effect";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";

const execute = promisify(execFile);
export interface GithubProfilePaths {
  stateDir: string;
  secretsDir?: string;
}
type ProtectedPath = { path: string; directory: boolean };

/** One Windows process per projection, rather than one per directory/secret/temp file. */
export async function secureGithubPaths(paths: ProtectedPath[]): Promise<void> {
  if (process.platform !== "win32") {
    for (const item of paths) await FS.chmod(item.path, item.directory ? 0o700 : 0o600);
    return;
  }
  const items = JSON.stringify(paths).replaceAll("'", "''");
  const script =
    `$ErrorActionPreference = 'Stop'; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
    `$items = ConvertFrom-Json '${items}'; foreach ($item in $items) { ` +
    `if ($item.directory) { $acl = New-Object System.Security.AccessControl.DirectorySecurity; $inheritance = 'ContainerInherit, ObjectInherit' } ` +
    `else { $acl = New-Object System.Security.AccessControl.FileSecurity; $inheritance = 'None' }; ` +
    `$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); ` +
    `$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, 'None', 'Allow'); ` +
    `$acl.AddAccessRule($rule); Set-Acl -LiteralPath $item.path -AclObject $acl }`;
  await execute("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
}

const disconnected = {
  user: "f5-disconnected",
  oauth_token: "f5-profile-not-connected",
  git_protocol: "https",
  users: { "f5-disconnected": { oauth_token: "f5-profile-not-connected" } },
};

/** Disposable profile projection, never an OS-keychain credential source. */
export class GithubCliProjection {
  constructor(
    private readonly paths: GithubProfilePaths,
    private readonly secrets: ServerSecretStoreShape,
  ) {}

  private async secretFiles(): Promise<string[]> {
    const directory = this.paths.secretsDir ?? Path.join(this.paths.stateDir, "secrets");
    const files = await FS.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const selected = files.filter((file) =>
      /^github-(?:token|login)-[a-z0-9][a-z0-9.-]*\.bin$/.test(file),
    );
    for (const file of selected) {
      if (!(await FS.lstat(Path.join(directory, file))).isFile())
        throw new Error("Invalid GitHub secret file.");
    }
    return selected.map((file) => Path.join(directory, file));
  }

  private async hosts(): Promise<string[]> {
    return [
      ...new Set(
        (await this.secretFiles()).flatMap((file) => {
          const host = /^github-(?:token|login)-(.*)\.bin$/.exec(Path.basename(file))?.[1];
          return host && !host.includes("..") ? [host] : [];
        }),
      ),
    ].sort();
  }

  async write(accounts: Record<string, unknown>): Promise<void> {
    const directory = Path.join(this.paths.stateDir, "github");
    await FS.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await FS.lstat(directory)).isDirectory())
      throw new Error("Invalid GitHub config directory.");
    const configPath = Path.join(directory, "config.yml");
    const existing = await FS.readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const config: unknown = parse(existing);
    if (config !== null && (typeof config !== "object" || Array.isArray(config)))
      throw new Error("Invalid GitHub CLI configuration.");
    const content = [
      ["hosts.yml", stringify({ "github.com": disconnected, ...accounts })],
      ["config.yml", stringify({ ...(config as Record<string, unknown> | null), version: "1" })],
    ] as const;
    const files: { target: string; temporary: string; content: string }[] = [];
    try {
      for (const [name, value] of content) {
        const temporary = Path.join(directory, `.${name}-${randomUUID()}.tmp`);
        const file = await FS.open(temporary, "wx", 0o600);
        await file.close();
        files.push({ target: Path.join(directory, name), temporary, content: value });
      }
      const secrets = await this.secretFiles();
      const secretsDirectory = this.paths.secretsDir ?? Path.join(this.paths.stateDir, "secrets");
      const secretsStat = await FS.lstat(secretsDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (secretsStat && !secretsStat.isDirectory())
        throw new Error("Invalid GitHub secret directory.");
      await secureGithubPaths([
        { path: directory, directory: true },
        ...(secretsStat ? [{ path: secretsDirectory, directory: true }] : []),
        ...secrets.map((path) => ({ path, directory: false })),
        ...files.map((file) => ({ path: file.temporary, directory: false })),
      ]);
      for (const file of files) {
        const handle = await FS.open(file.temporary, "r+");
        try {
          await handle.writeFile(file.content);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await FS.rename(file.temporary, file.target);
      }
    } finally {
      for (const file of files) await FS.rm(file.temporary, { force: true });
    }
  }

  async invalidate(): Promise<void> {
    await this.write(Object.fromEntries((await this.hosts()).map((host) => [host, disconnected])));
  }

  async rebuild(): Promise<void> {
    const accounts: Record<string, unknown> = {};
    for (const host of await this.hosts()) {
      const bytes = await Effect.runPromise(this.secrets.get(`github-token-${host}`));
      if (!bytes) {
        accounts[host] = disconnected;
        continue;
      }
      const token = new TextDecoder().decode(bytes);
      if (!token.trim() || /[\r\n]/.test(token) || token.includes("\0"))
        throw new Error("Invalid saved GitHub credential.");
      const login = await Effect.runPromise(this.secrets.get(`github-login-${host}`));
      const user = login?.length ? new TextDecoder().decode(login) : "f5-profile";
      accounts[host] = {
        oauth_token: token,
        git_protocol: "https",
        user,
        users: { [user]: { oauth_token: token } },
      };
    }
    await this.write(accounts);
  }
}
