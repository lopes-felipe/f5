import { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
export { fallbackDefaultProfile } from "@t3tools/shared/profileIdentity";
import { deriveServerPaths, ensureStateDirectories } from "../config";
import * as FS from "node:fs/promises";
import { watch } from "node:fs";
import * as Path from "node:path";
import * as Net from "node:net";
import { randomUUID } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Schema } from "effect";
import {
  ProfileRegistryFile,
  ProfileRecord,
  ServerSettings,
  type ProfileRegistryDiagnostic,
  type ProfileCreateInput,
  type ProfileUpdateInput,
  type ProfileSummary,
} from "@t3tools/contracts";
import {
  profileStateDir,
  profilesRootDir,
  profileRegistryPath,
  profileLocksDir,
  profileTrashDir,
  profileProviderHomesDir,
} from "@t3tools/shared/profilePaths";
import { writeFileStringAtomically } from "../atomicWrite";
import { isPathWithinRoot, safeLstat } from "../storage/storagePathSafety";
import { acquireInstanceLock, ProfileBusyError } from "./InstanceLock";

export type ProfileRegistryRead =
  | { ok: true; registry: ProfileRegistryFile }
  | { ok: false; diagnostic: ProfileRegistryDiagnostic };
const atomicWrite = (filePath: string, contents: string) =>
  Effect.runPromise(
    writeFileStringAtomically({ filePath, contents }).pipe(Effect.provide(NodeServices.layer)),
  );
export async function assertProfileDirectory(
  defaultStateDir: string,
  record: ProfileRecord,
): Promise<string> {
  const directory = profileStateDir(defaultStateDir, record);
  const root = record.isDefault ? Path.dirname(directory) : profilesRootDir(defaultStateDir);
  if (!isPathWithinRoot({ root, target: directory }))
    throw new Error("Profile directory escapes its root.");
  const stat = await safeLstat(directory);
  if (stat?.isSymbolicLink())
    throw new Error(`Profile directory is a symbolic link or junction: ${directory}`);
  if (stat && !stat.isDirectory()) throw new Error(`Profile path is not a directory: ${directory}`);
  if (stat) {
    const [realRoot, realDirectory] = await Promise.all([
      FS.realpath(root),
      FS.realpath(directory),
    ]);
    if (!isPathWithinRoot({ root: realRoot, target: realDirectory }))
      throw new Error("Profile directory resolves outside its root.");
  }
  return directory;
}
export const isProfilePortBindable = (port: number, host = "127.0.0.1") =>
  new Promise<boolean>((resolve) => {
    const server = Net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });

/** All registry mutations, including initial creation, go through this writer. */
export class ProfileRegistryStore {
  readonly root: string;
  readonly path: string;
  private lastContents = "";
  private listeners = new Set<() => void>();
  constructor(
    readonly defaultStateDir: string,
    readonly portBase = 3773,
  ) {
    this.root = profilesRootDir(defaultStateDir);
    this.path = profileRegistryPath(defaultStateDir);
  }
  private diagnostic(
    code: ProfileRegistryDiagnostic["code"],
    message: string,
  ): ProfileRegistryRead {
    return { ok: false, diagnostic: { code, message, path: this.path } };
  }
  async read(): Promise<ProfileRegistryRead> {
    let raw: string;
    try {
      if (
        (await safeLstat(this.root))?.isSymbolicLink() ||
        (await safeLstat(this.path))?.isSymbolicLink()
      )
        return this.diagnostic(
          "invariant-violation",
          "Profile registry paths cannot be symbolic links or junctions.",
        );
      raw = await FS.readFile(this.path, "utf8");
    } catch (error) {
      return this.diagnostic("unreadable", `Cannot read profile registry: ${String(error)}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return this.diagnostic(
        "malformed",
        "Profile registry is not valid JSON. Restore a valid registry; this file will not be overwritten.",
      );
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      typeof value.version === "number" &&
      value.version > 1
    )
      return this.diagnostic(
        "newer-version",
        "This registry was written by a newer F5 version. Upgrade F5 to use it.",
      );
    let registry: ProfileRegistryFile;
    try {
      registry = Schema.decodeUnknownSync(ProfileRegistryFile)(value, {
        onExcessProperty: "preserve",
      });
      if (registry.version !== 1) throw new Error("Unsupported registry version.");
    } catch (error) {
      return this.diagnostic("malformed", `Invalid profile registry: ${String(error)}`);
    }
    try {
      if (registry.profiles.filter((p) => p.isDefault).length !== 1)
        throw new Error("Exactly one default profile is required.");
      for (const field of ["id", "slug", "port"] as const) {
        if (new Set(registry.profiles.map((p) => p[field])).size !== registry.profiles.length)
          throw new Error(`Duplicate profile ${field}.`);
      }
      if (registry.profiles.some((p) => p.isDefault !== (p.slug === "default")))
        throw new Error("The default slug is reserved for Default.");
      for (const profile of registry.profiles)
        await assertProfileDirectory(this.defaultStateDir, profile);
    } catch (error) {
      return this.diagnostic("invariant-violation", String(error));
    }
    return { ok: true, registry };
  }
  private async required(): Promise<ProfileRegistryFile> {
    const result = await this.read();
    if (!result.ok) throw new Error(result.diagnostic.message);
    return result.registry;
  }
  private async write(registry: ProfileRegistryFile): Promise<void> {
    Schema.decodeUnknownSync(ProfileRegistryFile)(registry);
    const contents = JSON.stringify(registry, null, 2) + "\n";
    await atomicWrite(this.path, contents);
    this.lastContents = contents;
    for (const listener of this.listeners) listener();
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const directory = profileLocksDir(this.defaultStateDir);
    await FS.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await safeLstat(directory))?.isSymbolicLink())
      throw new Error("Profile lock directory cannot be a symbolic link or junction.");
    const lockPath = Path.join(directory, "registry.lock");
    let guard: Awaited<ReturnType<typeof acquireInstanceLock>> | undefined;
    const deadline = Date.now() + 5000;
    while (!guard) {
      try {
        guard = await acquireInstanceLock(Path.join(directory, "registry.guard.lock.sqlite"));
      } catch (error) {
        if (!(error instanceof ProfileBusyError)) throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Profile registry is busy (${lockPath}). Retry when the current mutation completes.`,
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    let handle: Awaited<ReturnType<typeof FS.open>> | undefined;
    try {
      // Every writer holds the OS guard before creating this marker. Exclusive
      // ownership proves a leftover marker has no live writer, even after SIGKILL.
      const abandoned = await safeLstat(lockPath);
      if (abandoned) {
        if (!abandoned.isFile() || abandoned.isSymbolicLink())
          throw new Error("Registry lock marker is not a regular file.");
        await FS.unlink(lockPath);
      }
      handle = await FS.open(lockPath, "wx", 0o600);
      return await operation();
    } finally {
      try {
        if (handle) {
          await handle.close();
          await FS.unlink(lockPath);
        }
      } finally {
        guard.release();
      }
    }
  }

  async init(): Promise<ProfileRegistryRead> {
    // Never write inside the state directory before legacy migration.
    await FS.mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await FS.lstat(this.root)).isSymbolicLink())
      throw new Error("Profiles root cannot be a symbolic link or junction.");
    await this.locked(async () => {
      if (!(await safeLstat(this.path)))
        await this.write({
          version: 1,
          retiredPorts: [],
          profiles: [fallbackDefaultProfile(this.defaultStateDir)],
        });
      const result = await this.read();
      if (!result.ok) return;
      let registry = result.registry;
      for (const record of registry.profiles) {
        if (record.isDefault) continue;
        const directory = await assertProfileDirectory(this.defaultStateDir, record);
        if (
          record.status === "provisioning" &&
          Date.now() - Date.parse(record.createdAt) > 600000 &&
          !(await safeLstat(Path.join(directory, "settings.json")))
        ) {
          registry = {
            ...registry,
            profiles: registry.profiles.filter((p) => p.id !== record.id),
            retiredPorts: [...new Set([...registry.retiredPorts, record.port])],
          };
        } else if (record.status === "removing") {
          const lock = await acquireInstanceLock(this.instanceLockPath(record));
          try {
            await this.moveToTrash(record);
            registry = {
              ...registry,
              profiles: registry.profiles.filter((p) => p.id !== record.id),
              retiredPorts: [...new Set([...registry.retiredPorts, record.port])],
            };
          } finally {
            lock.release();
          }
        }
      }
      if (registry !== result.registry) await this.write(registry);
      const installationPath = Path.join(this.root, "installation-id");
      if (!(await safeLstat(installationPath))) await atomicWrite(installationPath, randomUUID());
    });
    return this.read();
  }
  instanceLockPath(record: Pick<ProfileRecord, "id">) {
    return Path.join(profileLocksDir(this.defaultStateDir), `${record.id}.lock.sqlite`);
  }
  async list(
    activeId: string,
  ): Promise<{ profiles: ProfileSummary[]; diagnostic?: ProfileRegistryDiagnostic }> {
    const result = await this.read();
    const records = result.ok
      ? result.registry.profiles
      : [fallbackDefaultProfile(this.defaultStateDir)];
    return {
      profiles: records.map((record) => ({
        ...record,
        stateDir: profileStateDir(this.defaultStateDir, record),
        isActive: record.id === activeId,
        providerAccounts: [],
      })),
      ...(!result.ok ? { diagnostic: result.diagnostic } : {}),
    };
  }
  async create(input: ProfileCreateInput): Promise<ProfileRecord> {
    return this.locked(async () => {
      let registry = await this.required();
      let stem = input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 26);
      if (!/^[a-z]/.test(stem)) stem = `profile-${stem}`.slice(0, 26);
      let slug = stem;
      for (let suffix = 2; registry.profiles.some((p) => p.slug === slug); suffix++)
        slug = `${stem}-${suffix}`;
      const used = new Set([...registry.retiredPorts, ...registry.profiles.map((p) => p.port)]);
      let port = this.portBase;
      while (port <= 65535 && (used.has(port) || !(await isProfilePortBindable(port)))) port++;
      if (port > 65535) throw new Error("No unowned profile port is available.");
      const record = Schema.decodeUnknownSync(ProfileRecord)({
        id: randomUUID().replaceAll("-", ""),
        slug,
        name: input.name,
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        port,
        isDefault: false,
        status: "provisioning",
        createdAt: new Date().toISOString(),
      });
      const directory = await assertProfileDirectory(this.defaultStateDir, record);
      registry = { ...registry, profiles: [...registry.profiles, record] };
      await this.write(registry);
      const homes = profileProviderHomesDir(directory);
      for (const name of ["codex", "claude"])
        await FS.mkdir(Path.join(homes, name), { recursive: true, mode: 0o700 });
      await atomicWrite(
        Path.join(homes, "codex", "config.toml"),
        'cli_auth_credentials_store = "file"\n',
      );
      const seed = {
        providerInstances: {
          codex: {
            driver: "codex",
            displayName: "Codex",
            config: { homePath: Path.join(homes, "codex") },
          },
          claudeAgent: {
            driver: "claudeAgent",
            displayName: "Claude",
            config: { homePath: Path.join(homes, "claude") },
          },
        },
      };
      Schema.decodeUnknownSync(ServerSettings)(seed);
      await atomicWrite(Path.join(directory, "settings.json"), JSON.stringify(seed, null, 2));
      await FS.chmod(directory, 0o700);
      await Effect.runPromise(
        deriveServerPaths({
          baseDir: Path.dirname(this.defaultStateDir),
          defaultStateDir: this.defaultStateDir,
          profile: record,
        }).pipe(Effect.flatMap(ensureStateDirectories), Effect.provide(NodeServices.layer)),
      );
      const ready = { ...record, status: "ready" as const };
      await this.write({
        ...registry,
        profiles: registry.profiles.map((p) => (p.id === record.id ? ready : p)),
      });
      return ready;
    });
  }
  async update(input: ProfileUpdateInput): Promise<ProfileRecord> {
    return this.locked(async () => {
      const registry = await this.required();
      const record = registry.profiles.find((p) => p.id === input.profileId);
      if (!record || record.status !== "ready")
        throw new Error("Profile is not ready or does not exist.");
      if (input.port !== undefined && input.port !== record.port) {
        if (
          registry.profiles.some((p) => p.port === input.port) ||
          registry.retiredPorts.includes(input.port) ||
          !(await isProfilePortBindable(input.port))
        )
          throw new Error("That port is owned, retired, or already in use.");
      }
      const updated = {
        ...record,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.accentColor !== undefined ? { accentColor: input.accentColor } : {}),
      };
      await this.write({
        ...registry,
        profiles: registry.profiles.map((p) => (p.id === record.id ? updated : p)),
        retiredPorts:
          input.port !== undefined && input.port !== record.port
            ? [...new Set([...registry.retiredPorts, record.port])]
            : registry.retiredPorts,
      });
      return updated;
    });
  }
  private async moveToTrash(record: ProfileRecord): Promise<void> {
    const source = await assertProfileDirectory(this.defaultStateDir, record);
    if (!(await safeLstat(source))) return;
    const trash = profileTrashDir(this.defaultStateDir);
    await FS.mkdir(trash, { recursive: true, mode: 0o700 });
    if ((await FS.lstat(trash)).isSymbolicLink())
      throw new Error("Trash directory is a symbolic link.");
    await FS.rename(
      source,
      Path.join(trash, `${record.id}-${new Date().toISOString().replaceAll(":", "-")}`),
    );
  }
  async remove(profileId: string): Promise<void> {
    await this.locked(async () => {
      let registry = await this.required();
      const record = registry.profiles.find((p) => p.id === profileId);
      if (!record || record.isDefault) throw new Error("Default cannot be removed.");
      const lock = await acquireInstanceLock(this.instanceLockPath(record));
      try {
        await assertProfileDirectory(this.defaultStateDir, record);
        registry = {
          ...registry,
          profiles: registry.profiles.map((p) =>
            p.id === profileId ? { ...p, status: "removing" as const } : p,
          ),
        };
        await this.write(registry);
        await this.moveToTrash(record);
        await this.write({
          ...registry,
          profiles: registry.profiles.filter((p) => p.id !== profileId),
          retiredPorts: [...new Set([...registry.retiredPorts, record.port])],
        });
      } finally {
        lock.release();
      }
    });
  }
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(this.root, (_event, filename) => {
      if (filename?.toString() !== "profiles.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void FS.readFile(this.path, "utf8").then(
          (contents) => {
            if (contents === this.lastContents) return;
            this.lastContents = contents;
            listener();
          },
          () => listener(),
        );
      }, 100);
    });
    return () => {
      watcher.close();
      if (timer) clearTimeout(timer);
      this.listeners.delete(listener);
    };
  }
}
