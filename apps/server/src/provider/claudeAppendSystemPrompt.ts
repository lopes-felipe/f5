import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { Effect, Schema } from "effect";
import { readClaudeAppendSystemPromptArgs } from "@t3tools/shared/cliArgs";

export class ClaudeAppendSystemPromptError extends Schema.TaggedErrorClass<ClaudeAppendSystemPromptError>()(
  "ClaudeAppendSystemPromptError",
  {
    flag: Schema.Literals(["--append-system-prompt", "--append-system-prompt-file"]),
    /** Set when the file flag names a path that could not be read. */
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    if (this.path !== undefined) {
      return `Claude could not read the --append-system-prompt-file launch argument at ${this.path}. Fix the path in the Claude launch arguments, then send the message again.`;
    }
    return `The ${this.flag} launch argument has no ${this.flag === "--append-system-prompt" ? "text" : "file path"}. Add it after the flag in the Claude launch arguments, then send the message again.`;
  }
}

/**
 * Resolve the append launch arguments the way the Claude CLI would: file text
 * (one trailing newline trimmed) before inline text, the file read relative to
 * the session cwd. The adapter folds these flags out of `extraArgs`, so a value
 * the CLI would have rejected is rejected here instead of disappearing.
 */
export const resolveClaudeLaunchAppendSystemPrompt = Effect.fn(
  "resolveClaudeLaunchAppendSystemPrompt",
)(function* (input: {
  readonly launchArgs: Record<string, string | null> | undefined;
  readonly cwd: string | undefined;
}) {
  const args = readClaudeAppendSystemPromptArgs(input.launchArgs);
  // An explicit `--append-system-prompt ""` is a value the CLI accepts.
  if (args.text === null) {
    return yield* new ClaudeAppendSystemPromptError({ flag: "--append-system-prompt" });
  }
  let fileText: string | undefined;
  if (args.file !== undefined) {
    // `--append-system-prompt-file=` is "" and names no file either.
    if (args.file === null || args.file === "") {
      return yield* new ClaudeAppendSystemPromptError({ flag: "--append-system-prompt-file" });
    }
    const filePath = NodePath.resolve(input.cwd ?? process.cwd(), args.file);
    fileText = yield* Effect.tryPromise({
      try: () => NodeFs.readFile(filePath, "utf8"),
      catch: (cause) =>
        new ClaudeAppendSystemPromptError({
          flag: "--append-system-prompt-file",
          path: filePath,
          cause,
        }),
    });
  }
  return [fileText?.replace(/\r?\n$/, ""), args.text].filter(
    (text): text is string => typeof text === "string" && text.length > 0,
  );
});

/** F5's instructions first, then the launch-argument appends. */
export function joinClaudeSystemPromptAppend(
  instructions: string | undefined,
  launchAppends: ReadonlyArray<string>,
): string {
  return [instructions, ...launchAppends]
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n\n");
}
