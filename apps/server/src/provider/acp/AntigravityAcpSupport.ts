import { javascriptRuntimeExecutable } from "@t3tools/shared/hostRuntime";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Deferred, Duration, Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as AcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { RuntimeMode } from "@t3tools/contracts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";
import { findModelConfigOption, type AcpSessionModeState } from "./AcpRuntimeModel.ts";
import {
  acpReadOnlyWorkflowDecision,
  acpReadOnlyWorkflowVerdict,
  type AcpReadOnlyWorkflowDecisionInput,
  type AcpReadOnlyWorkflowVerdict,
} from "./AcpReadOnlyWorkflowPolicy.ts";
import { antigravityEditTargetsInWorkspace } from "./AntigravityEditLocation.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import { READ_ONLY_WORKFLOW_ENVIRONMENT } from "../readOnlyWorkflowShell.ts";
import {
  ANTIGRAVITY_PERSONAL_AUTH,
  antigravityLaunchEnvironment,
  antigravityProfileSettings,
  antigravityReadiness,
  redactAntigravityKey,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";

const hasErrorCode = (error: unknown, codes: readonly string[]) =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  codes.includes(String(error.code));

/** User-level instruction and skill-config files shared into each profile. */
const USER_CONFIG_FILES = [["AGENTS.md"], ["GEMINI.md"], ["config", "skills.json"]] as const;

/**
 * Share `~/.gemini/AGENTS.md`, `GEMINI.md` and `config/skills.json` into the profile, so an
 * instance reads the same user instructions Antigravity would read outside F5. Nothing F5 did
 * not create is touched: a regular file in the profile is user content and stays, and a link is
 * removed or replaced only when it points at the managed source. Windows copies (file symlinks
 * need elevation) and refreshes or removes only a copy whose bytes match one F5 published.
 */
export async function linkAntigravityUserConfigFiles(
  home: string,
  userHome: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (const segments of USER_CONFIG_FILES) {
    const source = path.join(userHome, ".gemini", ...segments);
    const target = path.join(home, ...segments);
    const marker = `${target}.f5-copy`;
    try {
      const sourceStat = await fs.stat(source).catch((error: unknown) => {
        if (hasErrorCode(error, ["ENOENT", "ENOTDIR"])) return undefined;
        throw error;
      });
      const existing = await fs.lstat(target).catch((error: unknown) => {
        if (hasErrorCode(error, ["ENOENT"])) return undefined;
        throw error;
      });
      // The marker lists the hashes of copies F5 published, one per line. A target edited since
      // matches none of them and is left alone, never refreshed or removed.
      const publishedHashes = await fs.readFile(marker, "utf8").then(
        (text) =>
          new Set(
            text
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          ),
        () => new Set<string>(),
      );
      const targetHash =
        existing?.isFile() === true ? sha256(await fs.readFile(target)) : undefined;
      const ownsCopy = targetHash !== undefined && publishedHashes.has(targetHash);
      const managedLink =
        existing?.isSymbolicLink() === true &&
        path.resolve(path.dirname(target), await fs.readlink(target)) === source;
      if (!sourceStat?.isFile()) {
        if (managedLink) await fs.unlink(target);
        else if (existing && ownsCopy) {
          await fs.rm(target, { force: true });
          await fs.rm(marker, { force: true });
        }
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (platform === "win32") {
        if (existing && !ownsCopy) continue;
        const contents = await fs.readFile(source);
        const nextHash = sha256(contents);
        if (targetHash === nextHash) continue;
        // Both the old and the new copy count as F5's while the file is replaced, so a failed
        // marker write after the swap can't make F5's own copy look user-edited.
        await fs.writeFile(marker, [targetHash, nextHash].filter(Boolean).join("\n"));
        await publishProfileFile(target, contents);
        await fs.writeFile(marker, nextHash);
        continue;
      }
      // Already linked, or a file or link the user made (one pointing elsewhere): left as it is.
      if (existing) continue;
      await fs.symlink(source, target, "file").catch((error: unknown) => {
        if (!hasErrorCode(error, ["EEXIST"])) throw error;
      });
    } catch (error) {
      await Effect.runPromise(
        Effect.logWarning("Antigravity user configuration is not linked into the profile.", {
          source,
          target,
          error,
        }),
      );
    }
  }
}

const sha256 = (contents: Buffer) => createHash("sha256").update(contents).digest("hex");

async function publishProfileFile(file: string, contents: string | Buffer): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function antigravityProfilesDirectory(stateDir: string): string {
  return path.join(stateDir, "providers", "antigravity", "accounts");
}

export function antigravityProfileKey(instanceId: string): string {
  return createHash("sha256").update(instanceId).digest("hex");
}

export function antigravityProfileDirectory(stateDir: string, instanceId: string): string {
  return path.join(antigravityProfilesDirectory(stateDir), antigravityProfileKey(instanceId));
}

export async function linkAntigravityUserSkills(home: string, userHome: string): Promise<void> {
  const hasCode = hasErrorCode;
  for (const directory of ["config", "antigravity-cli"]) {
    const source = path.join(userHome, ".gemini", directory, "skills");
    const target = path.join(home, directory, "skills");
    try {
      const sourceExists = await fs.stat(source).then(
        (stat) => stat.isDirectory(),
        (error: unknown) => {
          if (hasCode(error, ["ENOENT"])) return false;
          throw error;
        },
      );
      const existing = await fs.lstat(target).catch((error: unknown) => {
        if (hasCode(error, ["ENOENT"])) return undefined;
        throw error;
      });
      if (!sourceExists) {
        // The harness creates its own directory; a dangling link would break mkdir.
        if (existing?.isSymbolicLink()) await fs.unlink(target);
        continue;
      }
      if (existing?.isSymbolicLink()) {
        if (path.resolve(path.dirname(target), await fs.readlink(target)) === source) continue;
        await fs.unlink(target);
      } else if (existing?.isDirectory()) {
        // Only replace empty harness placeholders, never user content.
        try {
          await fs.rmdir(target);
        } catch (error) {
          if (hasCode(error, ["ENOTEMPTY", "EEXIST"])) continue;
          throw error;
        }
      } else if (existing) {
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs
        .symlink(source, target, process.platform === "win32" ? "junction" : "dir")
        .catch((error: unknown) => {
          if (!hasCode(error, ["EEXIST"])) throw error;
        });
    } catch (error) {
      // Skills are optional. Concurrent preparations and filesystem contention
      // must not prevent sign-in or session startup, or skip the other directory.
      await Effect.runPromise(
        Effect.logWarning("Antigravity user skills are not linked into the profile.", {
          source,
          target,
          error,
        }),
      );
    }
  }
}

/** Kept for call sites that predate per-method auth; defaults to the Google account method. */
export function antigravityEnvironment(
  base: NodeJS.ProcessEnv,
  home: string,
  harness: string | undefined,
  browserCommand: string,
  auth: AntigravityAuthConfig = ANTIGRAVITY_PERSONAL_AUTH,
): NodeJS.ProcessEnv {
  return antigravityLaunchEnvironment({ base, home, harness, browserCommand, auth });
}

export function antigravityAuthorizationUrl(value: string): string | undefined {
  try {
    if (value.length > 16_384) return undefined;
    const url = new URL(value.trim());
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    if (
      url.protocol !== "https:" ||
      url.hostname !== "accounts.google.com" ||
      url.pathname !== "/o/oauth2/v2/auth" ||
      url.username ||
      url.password ||
      callback.username ||
      callback.password ||
      callback.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname) ||
      !url.searchParams.get("state")
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export async function prepareAntigravityProfile(input: {
  stateDir: string;
  instanceId: string;
  environment: NodeJS.ProcessEnv;
  accountSetup?: boolean;
  auth?: AntigravityAuthConfig;
}) {
  const auth = input.auth ?? ANTIGRAVITY_PERSONAL_AUTH;
  const executable = await new AntigravityInstallation(input.stateDir).resolve();
  const home = antigravityProfileDirectory(input.stateDir, input.instanceId);
  await fs.mkdir(path.join(home, "antigravity-acp"), { recursive: true, mode: 0o700 });
  // Ordinary sessions, metadata and discovery need the same readiness the status shows: a key
  // must have passed Connect for exactly this method and key. Only account jobs skip it.
  if (!input.accountSetup) {
    const readiness = await antigravityReadiness({ profileDirectory: home, auth });
    if (!readiness.ready)
      throw new Error(readiness.message ?? "Sign in to Antigravity in Settings first.");
  }
  // Rewritten on every spawn so a method change never inherits the previous method's type.
  await publishProfileFile(
    path.join(home, "antigravity-acp", "settings.json"),
    antigravityProfileSettings(auth),
  );
  const userHome =
    process.platform === "win32"
      ? input.environment.USERPROFILE || os.homedir()
      : input.environment.HOME || os.homedir();
  // Share only user skills and instructions. MCP, hooks and credentials remain private.
  await linkAntigravityUserSkills(home, userHome);
  await linkAntigravityUserConfigFiles(home, userHome);
  // A helper handles browser requests without opening a browser in the server account.
  const helper = path.join(home, "browser.cjs");
  await publishProfileFile(
    helper,
    'process.stderr.on("error",()=>process.exit(0));process.stderr.write("F5_AUTH_URL="+JSON.stringify(process.argv[2])+"\\n");',
  );
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const wrapper = path.join(home, process.platform === "win32" ? "browser.cmd" : "browser.sh");
  const script =
    process.platform === "win32"
      ? `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${javascriptRuntimeExecutable().replaceAll("%", "%%")}" "${helper.replaceAll("%", "%%")}" %1\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(javascriptRuntimeExecutable())} ${quote(helper)} "$1"\n`;
  await publishProfileFile(wrapper, script);
  await fs.chmod(wrapper, 0o700);
  // Python webbrowser shlex-splits commands containing %s, including quoted paths.
  const browser = `${quote(wrapper)} %s`;
  return { executable, home, browser };
}

/**
 * `agy acp` arguments. A read-only workflow session adds `--sandbox`: shell commands run in
 * Antigravity's OS sandbox (Seatbelt on macOS, namespaces on Linux, AppContainer on Windows 11
 * 24H2+), with no network and no writes outside the workspace. Its permission prompts still reach
 * F5, which refuses anything that writes. The app-data dir stays `antigravity-acp` because its
 * sign-in tokens, conversations and plan artifacts live there, and F5 reads those from that path.
 */
export function antigravityAcpArgs(home: string, readOnlySandbox: boolean): ReadonlyArray<string> {
  return [
    "acp",
    ...(readOnlySandbox ? ["--sandbox"] : []),
    "--gemini-dir",
    home,
    "--app-data-dir",
    "antigravity-acp",
  ];
}

/**
 * The runtime input the Antigravity driver launches with: everything the adapter asked for,
 * including `readOnlySandbox`, plus the instance's own settings. Kept as a spread on purpose, so
 * a field the adapter adds later can't be dropped by picking fields one by one.
 */
export function antigravityDriverRuntimeInput<Input extends object, Instance extends object>(
  input: Input,
  instance: Instance,
): Input & Instance {
  return { ...input, ...instance };
}

export const makeAntigravityAcpRuntime = (input: {
  stateDir: string;
  instanceId: string;
  environment: NodeJS.ProcessEnv;
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  cwd: string;
  resumeSessionId?: string;
  accountSetup?: boolean;
  onAuthorizationUrl?: (url: string) => void;
  mcpServers?: AcpSessionRuntimeOptions["mcpServers"];
  sessionMeta?: AcpSessionRuntimeOptions["sessionMeta"];
  requestLogger?: AcpSessionRuntimeOptions["requestLogger"];
  logWritersRedact?: AcpSessionRuntimeOptions["logWritersRedact"];
  protocolLogging?: AcpSessionRuntimeOptions["protocolLogging"];
  sanitizeStderr?: AcpSessionRuntimeOptions["sanitizeStderr"];
  hasSensitiveConfiguration?: AcpSessionRuntimeOptions["hasSensitiveConfiguration"];
  auth?: AntigravityAuthConfig;
  /** A read-only workflow session: launch it in Antigravity's native sandbox. */
  readOnlySandbox?: boolean;
  /**
   * A read-only workflow session, sandboxed or not. Where the sandbox can't start (F5's macOS
   * desktop backend already runs in one), the session runs without `--sandbox` and F5's command
   * policy decides every command.
   */
  readOnlyWorkflow?: boolean;
}): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const auth = input.auth ?? ANTIGRAVITY_PERSONAL_AUTH;
    const prepared = yield* Effect.tryPromise({
      try: () => prepareAntigravityProfile(input),
      catch: (cause) =>
        new AcpErrors.AcpTransportError({
          detail: "Antigravity is not installed or its profile could not be prepared.",
          cause,
        }),
    });
    const signInRequired = yield* Deferred.make<void>();
    let stderr = "";
    const announce = (value: string) => {
      const url = antigravityAuthorizationUrl(value);
      if (url) {
        if (input.accountSetup) input.onAuthorizationUrl?.(url);
        else Effect.runSync(Deferred.succeed(signInRequired, undefined));
      }
    };
    const tempDirectory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => fs.mkdtemp(path.join(prepared.home, ".runtime-")),
        catch: (cause) =>
          new AcpErrors.AcpTransportError({
            detail: "Could not create Antigravity runtime directory.",
            cause,
          }),
      }),
      (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
    );
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        cwd: input.cwd,
        ...(input.hasSensitiveConfiguration
          ? { hasSensitiveConfiguration: input.hasSensitiveConfiguration }
          : {}),
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        ...(input.sessionMeta ? { sessionMeta: input.sessionMeta } : {}),
        ...(input.logWritersRedact ? { logWritersRedact: true } : {}),
        ...(input.requestLogger ? { requestLogger: input.requestLogger } : {}),
        ...(input.protocolLogging ? { protocolLogging: input.protocolLogging } : {}),
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        resumeMethod: "resume",
        authMethodId: auth.authMethod,
        clientInfo: { name: "f5", version: "1" },
        hardening: { enabled: true, provider: "antigravity" },
        clientCapabilities: {
          elicitation: { form: {} },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        spawn: {
          command: prepared.executable.executablePath,
          args: antigravityAcpArgs(prepared.home, input.readOnlySandbox === true),
          cwd: input.cwd,
          env: {
            ...antigravityEnvironment(
              input.environment,
              prepared.home,
              prepared.executable.harnessPath,
              prepared.browser,
              auth,
            ),
            TMPDIR: tempDirectory,
            TMP: tempDirectory,
            TEMP: tempDirectory,
            ...(input.readOnlySandbox === true || input.readOnlyWorkflow === true
              ? READ_ONLY_WORKFLOW_ENVIRONMENT
              : {}),
          },
          extendEnv: false,
        },
        transformStdoutLine: (line) => {
          const prefix = "Open the following link to authenticate the ACP server: ";
          if (line.startsWith(prefix)) {
            announce(line.slice(prefix.length));
            return "";
          }
          return line;
        },
        sanitizeStderr: (text) =>
          redactAntigravityKey(input.sanitizeStderr?.(text) ?? text, auth.apiKey).replace(
            /https:\/\/[^\s"<>]+/g,
            "[URL redacted]",
          ),
        onStderr: (chunk) => {
          stderr = (stderr + chunk).slice(-32_768);
          let newline: number;
          while ((newline = stderr.indexOf("\n")) >= 0) {
            const line = stderr.slice(0, newline);
            stderr = stderr.slice(newline + 1);
            if (line.startsWith("Open the following link to authenticate the ACP server: "))
              announce(
                line.slice("Open the following link to authenticate the ACP server: ".length),
              );
            if (line.startsWith("F5_AUTH_URL=")) {
              try {
                const value: unknown = JSON.parse(line.slice(12));
                if (typeof value === "string") announce(value);
              } catch {
                /* Ignore incomplete diagnostics. */
              }
            }
          }
        },
      } satisfies AcpSessionRuntimeOptions).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
    const shaped: AcpSessionRuntimeShape = {
      ...runtime,
      start: () =>
        Effect.raceFirst(
          runtime.start(),
          Deferred.await(signInRequired).pipe(
            Effect.andThen(
              Effect.fail(
                new AcpErrors.AcpTransportError({
                  detail: "Sign in to Antigravity in Settings before continuing.",
                  cause: undefined,
                }),
              ),
            ),
          ),
        ),
      setSessionModel: (model) => runtime.setModel(model).pipe(Effect.as({})),
    };
    antigravityLaunchedVersions.set(shaped, prepared.executable.version ?? null);
    return shaped;
  });

/**
 * The Antigravity version each runtime was spawned from. Checks that depend on the version (the
 * private-format gate) read it here instead of resolving the installation again, which could
 * name an update that became active after the launch.
 */
const antigravityLaunchedVersions = new WeakMap<object, string | null>();
export const antigravityLaunchedVersion = (runtime: object): string | null | undefined =>
  antigravityLaunchedVersions.get(runtime);

// ── Models and thinking levels (R2) ─────────────────────────────────────────

export const ANTIGRAVITY_DEFAULT_MODEL = "antigravity-default";

type SelectConfigOption = Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>;

const selectValues = (option: SelectConfigOption | undefined) =>
  (option?.options ?? []).flatMap((entry) =>
    "value" in entry ? [entry] : entry.options.map((choice) => choice),
  );

/** The per-model thinking control: the select whose category is `thought_level`. */
export function antigravityThinkingOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): SelectConfigOption | undefined {
  return (configOptions ?? []).find(
    (option): option is SelectConfigOption =>
      option.type === "select" && option.category === "thought_level",
  );
}

export interface AntigravityThinkingLevels {
  readonly levels: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly defaultLevel: string | undefined;
}

/** Levels the current model lists, or null when it has no thinking control (Orchestrator). */
export function antigravityThinkingLevels(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): AntigravityThinkingLevels | null {
  const option = antigravityThinkingOption(configOptions);
  if (!option) return null;
  return {
    levels: selectValues(option).map((entry) => ({ value: entry.value, name: entry.name })),
    defaultLevel: option.currentValue || undefined,
  };
}

/** Per-session record of the level a model had before F5 wrote one. */
export interface AntigravitySelectionState {
  baseline?: { readonly model: string; readonly level: string | undefined };
  readonly warnedLevels: Set<string>;
}

export const makeAntigravitySelectionState = (): AntigravitySelectionState => ({
  warnedLevels: new Set(),
});

export interface AntigravitySelectionResult {
  readonly model: string | undefined;
  readonly thinking: string | undefined;
  /** One warning per model and level when the level is unavailable and the default is used. */
  readonly warning?: string;
}

export class AntigravityModelUnavailableError extends Error {}

/**
 * The single selection path for sessions and text generation:
 * set the model, re-read config options, then write the level only if that model lists it.
 *
 * - No level selected restores the value seen right after `setModel` if F5 had changed it.
 * - A legacy effort-suffixed ID (`gemini-3.8-flash-high`) translates only when the advertised base
 *   model and level both match; an explicit level wins over the suffix.
 * - An unavailable model fails before anything is sent; an unavailable level falls back to the
 *   model default with one warning.
 */
export const applyAntigravityModelSelection = <E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly requestedModel: string | null | undefined;
  readonly requestedThinking: string | null | undefined;
  readonly customModels?: ReadonlyArray<string>;
  readonly state: AntigravitySelectionState;
  readonly mapError: (cause: AcpErrors.AcpError | AntigravityModelUnavailableError) => E;
}): Effect.Effect<AntigravitySelectionResult, E> =>
  Effect.gen(function* () {
    const read = input.runtime.getConfigOptions;
    const lift = <A>(effect: Effect.Effect<A, AcpErrors.AcpError>) =>
      effect.pipe(Effect.mapError(input.mapError));
    const options = yield* read;
    const modelOption = findModelConfigOption(options);
    const current = modelOption?.currentValue || undefined;
    const offered = modelOption ? selectValues(modelOption).map((entry) => entry.value) : undefined;
    const requested =
      input.requestedModel && input.requestedModel !== ANTIGRAVITY_DEFAULT_MODEL
        ? input.requestedModel
        : undefined;
    let explicitLevel = input.requestedThinking?.trim() || undefined;
    let target = requested;
    let switched = false;
    if (
      target &&
      offered !== undefined &&
      !offered.includes(target) &&
      !(input.customModels ?? []).includes(target)
    ) {
      const base = offered
        .filter((value) => target!.startsWith(`${value}-`))
        .toSorted((left, right) => right.length - left.length)[0];
      const suffix = base ? target.slice(base.length + 1) : undefined;
      let translated = false;
      if (base && suffix) {
        const priorLevel = antigravityThinkingOption(options)?.currentValue || undefined;
        if (base !== current) yield* lift(input.runtime.setModel(base));
        const levels = antigravityThinkingLevels(yield* read);
        if (levels?.levels.some((level) => level.value === suffix)) {
          translated = true;
          switched = base !== current;
          explicitLevel ??= suffix;
          target = base;
        } else if (base !== current && current) {
          // A rejected translation leaves the model and level that were active before it.
          yield* lift(input.runtime.setModel(current));
          const restored = antigravityThinkingOption(yield* read);
          if (
            priorLevel &&
            restored &&
            restored.currentValue !== priorLevel &&
            selectValues(restored).some((entry) => entry.value === priorLevel)
          )
            yield* lift(input.runtime.setConfigOption(restored.id, priorLevel));
        }
      }
      if (!translated)
        return yield* Effect.fail(
          input.mapError(
            new AntigravityModelUnavailableError(
              `Antigravity model '${requested}' is unavailable for this account. Select an available model.`,
            ),
          ),
        );
    }
    if (target && target !== current && !switched) {
      yield* lift(input.runtime.setModel(target));
      switched = true;
    }
    const model = target ?? current;
    const afterModel = yield* read;
    const thought = antigravityThinkingOption(afterModel);
    // The value seen right after the model was (re)selected is the model's own default.
    if (switched || input.state.baseline?.model !== model)
      input.state.baseline = { model: model ?? "", level: thought?.currentValue || undefined };
    const levels = selectValues(thought).map((entry) => entry.value);
    let warning: string | undefined;
    let level = explicitLevel;
    if (level && thought && !levels.includes(level)) level = undefined;
    if (explicitLevel && (!thought || level === undefined)) {
      const key = `${model ?? ""}\0${explicitLevel}`;
      if (!input.state.warnedLevels.has(key)) {
        input.state.warnedLevels.add(key);
        warning = `Thinking level '${explicitLevel}' is not available for ${model ?? "this model"}; using the model default.`;
      }
    }
    const desired = level ?? input.state.baseline?.level;
    if (thought && desired && thought.currentValue !== desired && levels.includes(desired))
      yield* lift(input.runtime.setConfigOption(thought.id, desired));
    return {
      model,
      thinking: thought ? (desired ?? (thought.currentValue || undefined)) : undefined,
      ...(warning ? { warning } : {}),
    };
  });

// ── Session modes and approvals (R3) ────────────────────────────────────────

export type AntigravitySessionMode = "default" | "plan" | "auto";

/** Modes the session advertises, through session mode state or a `mode` config option. */
export function antigravityAdvertisedModes(
  modeState: AcpSessionModeState | undefined,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): {
  readonly surface: "session-mode" | "config-option" | "none";
  readonly modes: ReadonlyArray<string>;
  readonly current: string | undefined;
  readonly configId?: string;
} {
  if (modeState)
    return {
      surface: "session-mode",
      modes: modeState.availableModes.map((mode) => mode.id),
      current: modeState.currentModeId,
    };
  const option = (configOptions ?? []).find(
    (candidate): candidate is SelectConfigOption =>
      candidate.type === "select" && (candidate.category === "mode" || candidate.id === "mode"),
  );
  if (option)
    return {
      surface: "config-option",
      modes: selectValues(option).map((entry) => entry.value),
      current: option.currentValue,
      configId: option.id,
    };
  return { surface: "none", modes: [], current: undefined };
}

/**
 * The one owner of the native mode. `plan` while the plan toggle is on, native `auto` for Auto
 * when advertised, and `default` otherwise: F5 enforces Supervised, Auto-accept edits and Full
 * access itself by answering `default`'s permission requests.
 */
export function antigravityTargetMode(input: {
  readonly runtimeMode: RuntimeMode;
  readonly plan: boolean;
  readonly advertised: ReadonlyArray<string>;
}): AntigravitySessionMode {
  if (input.plan) return "plan";
  if (input.runtimeMode === "auto" && input.advertised.includes("auto")) return "auto";
  return "default";
}

export class AntigravityModeUnavailableError extends Error {}

/**
 * Writes the target mode through exactly one surface: `session/set_mode` when the session
 * advertises mode state, otherwise the `mode` config option. Skips the write when the tracked
 * mode already matches. A mode the session does not advertise fails before any prompt, and so
 * does failing to enter or leave Plan. A rejected `auto` write falls back to `default` (F5 then
 * asks like Supervised) and reports one warning through `onAutoFallback`.
 */
export const applyAntigravitySessionMode = <E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getModeState" | "getConfigOptions" | "setNativeMode" | "setConfigOption"
  >;
  readonly target: AntigravitySessionMode;
  readonly mapError: (cause: AcpErrors.AcpError | AntigravityModeUnavailableError) => E;
  readonly onAutoFallback?: (warning: string) => void;
}): Effect.Effect<string, E> =>
  input.target !== "auto"
    ? writeAntigravitySessionMode(input)
    : writeAntigravitySessionMode({ ...input, mapError: (cause) => cause }).pipe(
        Effect.catch(() =>
          // The fallback is recorded only once the session is really in `default`: a failed
          // switch stops the turn and leaves Auto to be tried again next time.
          writeAntigravitySessionMode({ ...input, target: "default" }).pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                input.onAutoFallback?.(
                  "Antigravity did not accept native Auto, so this session runs as Supervised and asks before acting.",
                ),
              ),
            ),
          ),
        ),
      );

const writeAntigravitySessionMode = <E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getModeState" | "getConfigOptions" | "setNativeMode" | "setConfigOption"
  >;
  readonly target: AntigravitySessionMode;
  readonly mapError: (cause: AcpErrors.AcpError | AntigravityModeUnavailableError) => E;
}): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    const advertised = antigravityAdvertisedModes(
      yield* input.runtime.getModeState,
      yield* input.runtime.getConfigOptions,
    );
    if (advertised.current === input.target) return input.target;
    if (!advertised.modes.includes(input.target)) {
      // A session that names no `default` mode keeps its own; F5 still answers its requests.
      // Staying in Plan or native Auto is never silent: in Plan the turn would run under Plan's
      // rules, and in Auto Antigravity's own reviewer would approve what F5 never sees.
      if (
        input.target === "default" &&
        advertised.current !== "plan" &&
        advertised.current !== "auto"
      )
        return advertised.current ?? input.target;
      return yield* Effect.fail(
        input.mapError(
          new AntigravityModeUnavailableError(
            input.target === "plan"
              ? "This Antigravity runtime does not offer Plan mode. Update Antigravity in Settings, or turn Plan off."
              : advertised.current === "plan"
                ? "This Antigravity session could not leave Plan mode. Start a new session to continue."
                : advertised.current === "auto"
                  ? "This Antigravity session could not leave native Auto, so F5 cannot enforce the selected access mode. Start a new session to continue."
                  : `This Antigravity session does not offer the '${input.target}' mode.`,
          ),
        ),
      );
    }
    if (advertised.surface === "session-mode")
      yield* input.runtime.setNativeMode(input.target).pipe(Effect.mapError(input.mapError));
    else
      yield* input.runtime
        .setConfigOption(advertised.configId ?? "mode", input.target)
        .pipe(Effect.mapError(input.mapError));
    // A write the agent accepts but does not apply must not pass for a switch: a turn meant for
    // Plan would otherwise run under the access mode's rules.
    const effective = antigravityAdvertisedModes(
      yield* input.runtime.getModeState,
      yield* input.runtime.getConfigOptions,
    ).current;
    if (effective !== undefined && effective !== input.target)
      return yield* Effect.fail(
        input.mapError(
          new AntigravityModeUnavailableError(
            `Antigravity accepted the switch to '${input.target}' but stayed in '${effective}'. Start a new session to continue.`,
          ),
        ),
      );
    return input.target;
  });

// ── Read-only workflow turns ─────────────────────────────────────────────────

/**
 * Permission policy for a read-only workflow turn. It runs before the access-mode policy, saved
 * thread grants and Full access, and never opens an approval prompt. The policy itself is shared
 * with Cursor: see `acpReadOnlyWorkflowDecision`.
 */
export function antigravityReadOnlyWorkflowDecision(
  input: AcpReadOnlyWorkflowDecisionInput,
): "allow" | "deny" {
  return acpReadOnlyWorkflowDecision(input);
}

/** `antigravityReadOnlyWorkflowDecision` with the reason for a refusal. */
export function antigravityReadOnlyWorkflowVerdict(
  input: AcpReadOnlyWorkflowDecisionInput,
): AcpReadOnlyWorkflowVerdict {
  return acpReadOnlyWorkflowVerdict(input);
}

/** Read-only workflow sessions never run with native auto-approval, whatever the thread says. */
export function antigravityWorkflowRuntimeMode(
  runtimeMode: RuntimeMode,
  workflowExecutionProfile: string | undefined,
): RuntimeMode {
  return workflowExecutionProfile ? "approval-required" : runtimeMode;
}

/**
 * Enters Plan before a workflow prompt and confirms the session reports it. A runtime without
 * Plan, or one that reports any other mode afterwards, fails the turn before anything is sent.
 */
export const enterAntigravityWorkflowPlanMode = <E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getModeState" | "getConfigOptions" | "setNativeMode" | "setConfigOption"
  >;
  readonly mapError: (cause: AcpErrors.AcpError | AntigravityModeUnavailableError) => E;
}): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    yield* writeAntigravitySessionMode({ ...input, target: "plan" });
    const effective = antigravityAdvertisedModes(
      yield* input.runtime.getModeState,
      yield* input.runtime.getConfigOptions,
    ).current;
    if (effective !== "plan")
      return yield* Effect.fail(
        input.mapError(
          new AntigravityModeUnavailableError(
            "Antigravity could not confirm Plan mode, so F5 cannot keep this workflow turn read-only. Start a new session to continue.",
          ),
        ),
      );
    return effective;
  });

/**
 * ACP tool kinds that follow the thread's access mode in Plan. `kind` comes from the agent and
 * may be missing, `other` or new, so this is an allowlist: anything else asks.
 */
const ANTIGRAVITY_PLAN_ACCESS_MODE_KINDS: ReadonlySet<string> = new Set([
  "execute",
  "read",
  "search",
  "think",
]);

export type AntigravityApprovalDecision =
  | { readonly kind: "ask"; readonly applyThreadGrants: boolean }
  | { readonly kind: "allow" };

/**
 * Per-request policy from the start-time runtime mode and the tracked session mode. Questions,
 * forms and computer consent are handled (always asked) before this is consulted.
 */
export function antigravityApprovalDecision(input: {
  readonly runtimeMode: RuntimeMode;
  readonly sessionMode: string | undefined;
  /** The active turn asked for Plan, whatever the native mode reports. */
  readonly planRequested?: boolean;
  readonly computerRequest: boolean;
  readonly toolCall: Parameters<typeof antigravityEditTargetsInWorkspace>[0];
  readonly workspaceRoot: string;
}): AntigravityApprovalDecision {
  if (input.computerRequest) return { kind: "ask", applyThreadGrants: false };
  // In Plan, commands and read-only tools follow the thread's access mode as outside Plan, so
  // thread grants apply there too. Everything else (edits, deletes, moves, `other`, a missing or
  // unknown kind) always asks, without thread grants, even under Full access. Commands can still
  // change files; that is the access mode's call. The turn's own request counts as well as the
  // native mode, so a lagging mode can't widen a Plan turn.
  if (
    (input.sessionMode === "plan" || input.planRequested === true) &&
    !ANTIGRAVITY_PLAN_ACCESS_MODE_KINDS.has(input.toolCall.kind ?? "")
  )
    return { kind: "ask", applyThreadGrants: false };
  switch (input.runtimeMode) {
    case "full-access":
      return { kind: "allow" };
    case "auto-accept-edits":
      return antigravityEditTargetsInWorkspace(input.toolCall, input.workspaceRoot)
        ? { kind: "allow" }
        : { kind: "ask", applyThreadGrants: true };
    case "auto":
    case "approval-required":
      return { kind: "ask", applyThreadGrants: true };
  }
}

/**
 * Titles, branch names and commit messages should not spend Neon quota: with no explicit model,
 * prefer Hydrogen, then any Flash model, then the account default, at the lowest listed level.
 */
export function antigravityTextGenerationModel(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): string | undefined {
  const values = selectValues(findModelConfigOption(configOptions)).map((entry) => entry.value);
  return (
    values.find((value) => value.toLowerCase().includes("hydrogen")) ??
    values.find((value) => value.toLowerCase().includes("flash"))
  );
}

/** Known thinking levels from least to most effort; unknown names rank after them. */
const THINKING_LEVEL_ORDER = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The least-effort level by name, never by the agent's listing order. */
export function lowestAntigravityThinkingLevel(
  levels: ReadonlyArray<{ readonly value: string }>,
): string | undefined {
  const rank = (value: string) => {
    const index = THINKING_LEVEL_ORDER.indexOf(value.toLowerCase());
    return index === -1 ? THINKING_LEVEL_ORDER.length : index;
  };
  return levels
    .map((level, index) => ({ value: level.value, index }))
    .toSorted((left, right) => rank(left.value) - rank(right.value) || left.index - right.index)[0]
    ?.value;
}

/**
 * Text generation runs in the user's profile, where a model switch may persist as the account
 * default. With no explicit model it uses a light model at its lowest level; an explicit model
 * keeps the requested level (or one from a legacy suffix), or the model's default. Returns an
 * effect that restores the model and level that were active before, to run after the prompt.
 */
export const applyAntigravityTextGenerationSelection = (input: {
  readonly runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "setConfigOption" | "setModel"
  >;
  readonly model: string;
  readonly thinking: string | undefined;
  readonly customModels?: ReadonlyArray<string>;
}): Effect.Effect<Effect.Effect<void>, AcpErrors.AcpError | AntigravityModelUnavailableError> =>
  Effect.gen(function* () {
    const before = yield* input.runtime.getConfigOptions;
    const originalModel = findModelConfigOption(before)?.currentValue || undefined;
    const originalLevel = antigravityThinkingOption(before)?.currentValue || undefined;
    const explicit = input.model !== ANTIGRAVITY_DEFAULT_MODEL;
    const model = explicit ? input.model : antigravityTextGenerationModel(before);
    // Defined before the first write and driven by what the session reports now, so a setup
    // that switched the model and then failed on the level restores too.
    const restore = Effect.gen(function* () {
      const currentModel = findModelConfigOption(
        yield* input.runtime.getConfigOptions,
      )?.currentValue;
      if (originalModel && currentModel !== originalModel)
        yield* input.runtime.setModel(originalModel);
      const thought = antigravityThinkingOption(yield* input.runtime.getConfigOptions);
      if (
        originalLevel &&
        thought &&
        thought.currentValue !== originalLevel &&
        selectValues(thought).some((entry) => entry.value === originalLevel)
      )
        yield* input.runtime.setConfigOption(thought.id, originalLevel);
    }).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.catchCause(() =>
        Effect.logWarning("Antigravity text generation could not restore the model selection."),
      ),
    );
    yield* Effect.gen(function* () {
      yield* applyAntigravityModelSelection({
        runtime: input.runtime,
        requestedModel: model,
        requestedThinking: explicit ? input.thinking : undefined,
        ...(input.customModels ? { customModels: input.customModels } : {}),
        state: makeAntigravitySelectionState(),
        mapError: (cause) => cause,
      });
      if (!explicit) {
        const options = yield* input.runtime.getConfigOptions;
        const lowest = lowestAntigravityThinkingLevel(
          antigravityThinkingLevels(options)?.levels ?? [],
        );
        const thought = antigravityThinkingOption(options);
        if (lowest && thought && thought.currentValue !== lowest)
          yield* input.runtime.setConfigOption(thought.id, lowest);
      }
      // A failed or interrupted setup restores right here, while the runtime is still open; the
      // caller runs the returned restore once the prompt completes.
    }).pipe(Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : restore)));
    return restore;
  });
