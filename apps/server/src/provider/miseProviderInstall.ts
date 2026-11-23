import { statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { Schema } from "effect";
import { runProcess } from "../processRunner.ts";
import type { InstallTargetDependencies } from "./providerInstallChannel.ts";

export const MISE_PROVIDER_TOOLS: Readonly<Partial<Record<string, string>>> = {
  claudeAgent: "claude",
  codex: "codex",
  grok: "grok",
  muse: "muse",
  opencode: "opencode",
  pi: "pi",
};

const install = Schema.Struct({
  install_path: Schema.String,
  requested_version: Schema.optional(Schema.NullOr(Schema.String)),
  active: Schema.optional(Schema.Boolean),
});
const installs = Schema.Array(install);
const decodeInstalls = Schema.decodeUnknownSync(
  Schema.Union([installs, Schema.Record(Schema.String, installs)]),
);

export function isMiseWrapper(file: string): boolean {
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size > 8192) return false;
    const script = readFileSync(file, "utf8");
    return script.startsWith("#!") && /\bmise\s+(?:x|exec)\b/.test(script);
  } catch {
    return false;
  }
}

export interface MiseProviderInstallation {
  readonly realPath: string;
  readonly key: string;
  readonly upgrade: { readonly executable: string; readonly tool: string } | null;
}

export async function detectMiseProviderInstall(input: {
  tool: string | undefined;
  executable: string;
  realPath: string;
  environment: NodeJS.ProcessEnv;
  dependencies: Pick<InstallTargetDependencies, "resolveExecutable" | "realpath" | "platform"> & {
    runProcess: typeof runProcess;
    isMiseWrapper: typeof isMiseWrapper;
  };
}): Promise<MiseProviderInstallation | null> {
  const { tool, executable, realPath, environment, dependencies } = input;
  const windows = dependencies.platform === "win32";
  const path = windows ? Path.win32 : Path.posix;
  const normalize = (file: string) => {
    const normalized = file.replaceAll("\\", "/").replace(/\/+$/, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const canonical = (file: string) => {
    try {
      return dependencies.realpath(file);
    } catch {
      return file;
    }
  };
  const isMiseExecutable = (file: string) => /(?:^|\/)mise(?:\.exe)?$/.test(normalize(file));
  const shim = isMiseExecutable(realPath) || normalize(executable).includes("/mise/shims/");
  const wrapper = dependencies.isMiseWrapper(realPath);
  const looksMise =
    shim ||
    wrapper ||
    [executable, realPath].some((file) => {
      const normalized = normalize(file);
      return (
        normalized.includes("/mise/command-wrappers/") ||
        (normalized.includes("/mise/installs/") && !normalized.includes("/mise/installs/node/"))
      );
    });
  const manual: MiseProviderInstallation = {
    realPath,
    key: normalize(realPath),
    upgrade: null,
  };
  if (wrapper) return manual;
  const fallback = looksMise ? manual : null;
  if (!tool) return fallback;
  if (shim && normalize(path.basename(executable)).replace(/\.(?:exe|cmd|bat)$/, "") !== tool)
    return manual;
  const mise =
    (await dependencies.resolveExecutable("mise", environment, {
      platform: dependencies.platform,
      useCache: false,
      cwd: tmpdir(),
    })) ?? (isMiseExecutable(realPath) ? realPath : null);
  if (!mise || !isMiseExecutable(mise)) return fallback;
  const probe = async (args: readonly string[]) => {
    const result = await dependencies.runProcess(mise, args, {
      cwd: tmpdir(),
      // Ownership probes should never lazily install a tool referenced by a shim.
      env: { ...environment, MISE_OFFLINE: "1" },
      timeoutMs: 5_000,
      maxBufferBytes: 256 * 1024,
      allowNonZeroExit: true,
    });
    return result.code === 0 && !result.timedOut ? result.stdout.trim() : "";
  };
  const [which, listing] = await Promise.all([
    probe(["which", tool]).catch(() => ""),
    probe(["ls", "--json", "--installed", tool]).catch(() => ""),
  ]);
  const selected = path.isAbsolute(which) ? canonical(which) : null;
  const binary = shim ? selected : realPath;
  if (!binary) return fallback;
  const manualSelection =
    selected && normalize(selected) === normalize(binary)
      ? { realPath: binary, key: normalize(binary), upgrade: null }
      : fallback;
  try {
    const byTool = decodeInstalls(JSON.parse(listing));
    const candidates = Array.isArray(byTool)
      ? (byTool as ReadonlyArray<typeof install.Type>)
      : ((byTool as Readonly<Record<string, ReadonlyArray<typeof install.Type>>>)[tool] ?? []);
    const owning = candidates.filter(
      (candidate) =>
        path.isAbsolute(candidate.install_path) &&
        normalize(binary).startsWith(normalize(canonical(candidate.install_path)) + "/"),
    );
    const owner = owning.find(
      (candidate) => candidate.active && candidate.requested_version === "latest",
    );
    const first = owner ?? owning[0];
    if (!first) return fallback;
    const root = path.dirname(first.install_path);
    const latest = [root, canonical(root)].some((dir) =>
      normalize(executable).startsWith(normalize(path.join(dir, "latest")) + "/"),
    );
    return {
      realPath: binary,
      key: normalize(canonical(root)),
      upgrade:
        owner && selected && normalize(selected) === normalize(binary) && (shim || latest)
          ? { executable: mise, tool }
          : null,
    };
  } catch {
    return manualSelection;
  }
}
