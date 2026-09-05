/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";
import NodePath from "node:path";

import { EDITORS, type EditorId } from "@t3tools/contracts";
import { Cause, Effect, Exit, Layer, Schema, ServiceMap } from "effect";

import { editorLaunchTotal, increment } from "./observability/Metrics.ts";
import { isCommandAvailable, resolveInvocation } from "./spawn/resolveCommand.ts";

export { isCommandAvailable } from "./spawn/resolveCommand.ts";

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

export function resolveFileManagerRevealLaunch(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): EditorLaunch {
  switch (platform) {
    case "darwin":
      return { command: "open", args: ["-R", targetPath] };
    case "win32":
      return { command: "explorer", args: [`/select,${targetPath}`] };
    default:
      return { command: "xdg-open", args: [NodePath.posix.dirname(targetPath)] };
  }
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

  /** Reveal a file in the platform file manager without opening the file itself. */
  readonly revealInFileManager: (targetPath: string) => Effect.Effect<void, OpenError>;
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
        const invocation = resolveInvocation(launch.command, launch.args);
        child = spawn(invocation.file, [...invocation.args], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
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

  const revealInFileManager = Effect.fn("open.reveal-in-file-manager")(function* (
    targetPath: string,
  ) {
    const detachedExit = yield* Effect.exit(
      launchDetached(resolveFileManagerRevealLaunch(targetPath)),
    );
    if (Exit.isFailure(detachedExit)) {
      const error = Cause.squash(detachedExit.cause) as OpenError;
      yield* increment(editorLaunchTotal, {
        editorId: "file-manager",
        outcome: classifyEditorLaunchFailure(error),
      });
      return yield* Effect.failCause(detachedExit.cause);
    }
    yield* increment(editorLaunchTotal, { editorId: "file-manager", outcome: "success" });
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) => openInEditor(input).pipe(Effect.withSpan("open.in-editor")),
    revealInFileManager: (targetPath) =>
      revealInFileManager(targetPath).pipe(Effect.withSpan("open.reveal-in-file-manager")),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
