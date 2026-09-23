import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { Effect } from "effect";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";

const execute = promisify(execFile);
export interface GithubProfilePaths {
  stateDir: string;
  secretsDir?: string;
}

async function secure(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") {
    await FS.chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  // Replace the DACL, including explicit grants. chmod alone is insufficient on Windows.
  const literal = "'" + path.replaceAll("'", "''") + "'";
  const type = directory ? "DirectorySecurity" : "FileSecurity";
  const inheritance = directory ? "ContainerInherit, ObjectInherit" : "None";
  const script =
    `$ErrorActionPreference = 'Stop'; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ` +
    `$acl = New-Object System.Security.AccessControl.${type}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); ` +
    `$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', '${inheritance}', 'None', 'Allow'); ` +
    `$acl.AddAccessRule($rule); Set-Acl -LiteralPath ${literal} -AclObject $acl`;
  await execute("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
}

/** A disposable projection; never read credentials back from gh or the OS keychain. */
export class GithubCliProjection {
  constructor(
    private readonly paths: GithubProfilePaths,
    private readonly secrets: ServerSecretStoreShape,
  ) {}

  async write(accounts: Record<string, unknown>): Promise<void> {
    const directory = Path.join(this.paths.stateDir, "github");
    await FS.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await FS.lstat(directory)).isDirectory())
      throw new Error("Invalid GitHub config directory.");
    await secure(directory, true);
    const temporary = Path.join(directory, `.hosts-${randomUUID()}.tmp`);
    try {
      const file = await FS.open(temporary, "wx", 0o600);
      try {
        await secure(temporary, false);
        await file.writeFile(
          stringify({
            "github.com": { oauth_token: "f5-profile-not-connected", git_protocol: "https" },
            ...accounts,
          }),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await FS.rename(temporary, Path.join(directory, "hosts.yml"));
    } finally {
      await FS.rm(temporary, { force: true });
    }
  }

  async invalidate(): Promise<void> {
    const hosts = await this.hosts();
    await this.write(
      Object.fromEntries(
        hosts.map((host) => [
          host,
          { oauth_token: "f5-profile-not-connected", git_protocol: "https" },
        ]),
      ),
    );
  }

  private async hosts(): Promise<string[]> {
    const directory = this.paths.secretsDir ?? Path.join(this.paths.stateDir, "secrets");
    const files = await FS.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (files.length > 0) {
      await secure(directory, true);
      for (const file of files) {
        if (/^github-(?:token|login)-[a-z0-9][a-z0-9.-]*\.bin$/.test(file)) {
          const path = Path.join(directory, file);
          if (!(await FS.lstat(path)).isFile()) throw new Error("Invalid GitHub secret file.");
          await secure(path, false);
        }
      }
    }
    return [
      ...new Set(
        files.flatMap((file) => {
          const match = /^github-(?:token|login)-([a-z0-9][a-z0-9.-]*)\.bin$/.exec(file);
          return match && !match[1]!.includes("..") ? [match[1]!] : [];
        }),
      ),
    ].sort();
  }

  async rebuild(): Promise<void> {
    // A nonempty invalid credential prevents gh falling back to the workstation keychain.
    const disconnected = { oauth_token: "f5-profile-not-connected", git_protocol: "https" };
    const accounts: Record<string, unknown> = { "github.com": disconnected };
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
      accounts[host] = {
        oauth_token: token,
        git_protocol: "https",
        ...(login?.length ? { user: new TextDecoder().decode(login) } : {}),
      };
    }
    await this.write(accounts);
  }
}
