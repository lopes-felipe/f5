/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { extname, join } from "node:path";

import { EDITORS, type EditorId } from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Schema, ServiceMap } from "effect";

import { editorLaunchTotal, increment } from "./observability/Metrics.ts";

// ==============================
// Definitions
// ==============================

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface CommandAvailabilityOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

// Treat a trailing :line[:column] suffix as editor navigation metadata. This is
// intentionally ambiguous for literal paths ending in :<digits>, but it matches
// the existing VS Code-style convention and still handles Windows drive letters
// because the drive colon is not the final colon before the numeric suffix.
const POSITIONAL_TARGET_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

function parseTargetPosition(target: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} | null {
  const match = POSITIONAL_TARGET_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    path: match[1],
    line: match[2],
    column: match[3],
  };
}

function resolveEditorArgs(editorId: EditorId, target: string): ReadonlyArray<string> {
  const editor = EDITORS.find((entry) => entry.id === editorId);
  if (!editor) {
    return [target];
  }

  if (editor.id === "idea") {
    const parsedTarget = parseTargetPosition(target);
    if (!parsedTarget) {
      return [target];
    }

    return [
      ...(parsedTarget.line ? ["--line", parsedTarget.line] : []),
      ...(parsedTarget.column ? ["--column", parsedTarget.column] : []),
      parsedTarget.path,
    ];
  }

  const parsedTarget = parseTargetPosition(target);
  if (editor.supportsGoto === true && parsedTarget) {
    return ["--goto", target];
  }

  return [target];
}

function resolveEditorCommandCandidates(
  editor: (typeof EDITORS)[number],
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  if (!editor.command) {
    return [];
  }

  if (editor.id !== "idea") {
    return [editor.command];
  }

  // IntelliJ installs do not always expose a bare `idea` launcher on PATH.
  switch (platform) {
    case "win32":
      return [editor.command, "idea64.exe"];
    case "linux":
      return [editor.command, "idea.sh"];
    default:
      return [editor.command];
  }
}

function resolveEditorCommand(
  editor: (typeof EDITORS)[number],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const candidates = resolveEditorCommandCandidates(editor, platform);
  return (
    candidates.find((command) => isCommandAvailable(command, { platform, env })) ?? editor.command!
  );
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const extension of windowsPathExtensions) {
    candidates.push(`${command}${extension}`);
    candidates.push(`${command}${extension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function isExecutableFile(
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") {
      const extension = extname(filePath);
      if (extension.length === 0) return false;
      return windowsPathExtensions.includes(extension.toUpperCase());
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

export function isCommandAvailable(
  command: string,
  options: CommandAvailabilityOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(command, platform, windowsPathExtensions);

  if (command.includes("/") || command.includes("\\")) {
    return commandCandidates.some((candidate) =>
      isExecutableFile(candidate, platform, windowsPathExtensions),
    );
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) return false;
  const pathEntries = pathValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => stripWrappingQuotes(entry.trim()))
    .filter((entry) => entry.length > 0);

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      if (isExecutableFile(join(pathEntry, candidate), platform, windowsPathExtensions)) {
        return true;
      }
    }
  }
  return false;
}

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    const commandAvailable = editor.command
      ? resolveEditorCommandCandidates(editor, platform).some((command) =>
          isCommandAvailable(command, { platform, env }),
        )
      : isCommandAvailable(fileManagerCommandForPlatform(platform), { platform, env });
    if (commandAvailable) {
      available.push(editor.id);
    }
  }

  return available;
}

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends ServiceMap.Service<Open, OpenShape>()("t3/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fnUntraced(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<EditorLaunch, OpenError> {
  yield* Effect.annotateCurrentSpan({
    "open.editor": input.editor,
    "open.cwd": input.cwd,
    "open.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }

  if (editorDef.command) {
    return {
      command: resolveEditorCommand(editorDef, platform, env),
      args: resolveEditorArgs(editorDef.id, input.cwd),
    };
  }

  if (editorDef.id !== "file-manager") {
    return yield* new OpenError({ message: `Unsupported editor: ${input.editor}` });
  }

  return { command: fileManagerCommandForPlatform(platform), args: [input.cwd] };
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      "open.command": launch.command,
      "open.args_count": launch.args.length,
    });
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        child = spawn(launch.command, [...launch.args], {
          detached: true,
          stdio: "ignore",
          shell: process.platform === "win32",
        });
      } catch (error) {
        return resume(
          Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

function classifyEditorLaunchFailure(error: OpenError): string {
  if (error.message.startsWith("Unknown editor:")) {
    return "unknown-editor";
  }
  if (error.message.startsWith("Unsupported editor:")) {
    return "unsupported-editor";
  }
  if (error.message.startsWith("Editor command not found:")) {
    return "unavailable-command";
  }
  return "spawn-failure";
}

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  const openInEditor = Effect.fn("open.in-editor")(function* (input: OpenInEditorInput) {
    const launchExit = yield* Effect.exit(resolveEditorLaunch(input));
    if (Exit.isFailure(launchExit)) {
      const error = Cause.squash(launchExit.cause) as OpenError;
      yield* increment(editorLaunchTotal, {
        editorId: input.editor,
        outcome: classifyEditorLaunchFailure(error),
      });
      return yield* Effect.failCause(launchExit.cause);
    }

    const detachedExit = yield* Effect.exit(launchDetached(launchExit.value));
    if (Exit.isFailure(detachedExit)) {
      const error = Cause.squash(detachedExit.cause) as OpenError;
      yield* increment(editorLaunchTotal, {
        editorId: input.editor,
        outcome: classifyEditorLaunchFailure(error),
      });
      return yield* Effect.failCause(detachedExit.cause);
    }

    yield* increment(editorLaunchTotal, {
      editorId: input.editor,
      outcome: "success",
    });
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) => openInEditor(input).pipe(Effect.withSpan("open.in-editor")),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
