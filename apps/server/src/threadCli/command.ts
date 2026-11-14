import { Data, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  openThreadClient,
  resolveCliProject,
  readCliThread,
  readFullCliMessage,
  type ToolCall,
} from "./client.ts";
import {
  projectsSchema,
  threadsSchema,
  submittedSchema,
  waitSchema,
  MAX_MESSAGE_BYTES,
} from "./protocol.ts";

const json = Flag.boolean("json").pipe(Flag.withDefault(false));
const wait = Flag.boolean("wait").pipe(Flag.withDefault(false));
const message = Argument.string("message").pipe(
  Argument.withDescription("Message, or - to read stdin."),
);
const thread = Argument.string("thread");
const print = (value: unknown) => console.log(JSON.stringify(value));
class ThreadCliError extends Data.TaggedError("ThreadCliError")<{ readonly message: string }> {}
const commandError = (error: unknown) =>
  new ThreadCliError({
    message: error instanceof Error ? error.message : "F5 thread command failed.",
  });

export async function readCliMessage(argument: string): Promise<string> {
  let text = argument;
  if (argument === "-") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 128 KiB.");
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (!text.trim()) throw new Error("The message is empty.");
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 128 KiB.");
  return text;
}

export async function finishCliSubmission(
  call: ToolCall,
  sent: { threadId: string; submissionId: string },
  json: boolean,
) {
  while (true) {
    const result = await call("f5_thread_wait", sent, waitSchema);
    if (result.timedOut) continue;
    if (
      result.replyMessageId &&
      result.nextTextOffset !== null &&
      result.nextTextOffset !== undefined
    ) {
      result.reply = (
        await readFullCliMessage(call, sent.threadId, {
          id: result.replyMessageId,
          role: "assistant",
          turnId: null,
          text: result.reply ?? "",
          nextTextOffset: result.nextTextOffset,
        })
      ).text;
      result.nextTextOffset = null;
    }
    if (json) print(result);
    else if (result.reply !== null) console.log(result.reply);
    if (result.status === "waiting") {
      console.error(
        "Thread " +
          sent.threadId +
          " needs your attention. Open it in F5 to answer or resume its queue." +
          (result.reason ? " " + result.reason : ""),
      );
      process.exitCode = 2;
    } else if (result.status !== "completed") {
      console.error("Thread " + sent.threadId + " stopped: " + (result.reason ?? result.status));
      process.exitCode = 1;
    }
    return;
  }
}

export function makeThreadCommand<E, R>(resolveStateDir: Effect.Effect<string, E, R>) {
  const run = <P = undefined>(
    body: (call: ToolCall, prepared: P) => Promise<void>,
    prepare?: () => Promise<P>,
  ) =>
    Effect.gen(function* () {
      const prepared = yield* Effect.tryPromise({
        try: async () => (prepare ? await prepare() : (undefined as P)),
        catch: commandError,
      });
      const stateDir = yield* resolveStateDir;
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => openThreadClient(stateDir),
          catch: commandError,
        }),
        (client) => Effect.promise(() => client.close()),
      );
      yield* Effect.tryPromise({
        try: (signal) => body(client.call(signal), prepared),
        catch: commandError,
      });
    }).pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(error instanceof Error ? error.message : "F5 thread command failed.");
          process.exitCode = 1;
        }),
      ),
    );
  const start = Command.make("start", {
    project: Argument.string("project"),
    message,
    json,
    wait,
    title: Flag.string("title").pipe(Flag.optional),
    provider: Flag.string("provider").pipe(Flag.optional),
    model: Flag.string("model").pipe(Flag.optional),
    worktree: Flag.string("worktree").pipe(Flag.optional),
    branch: Flag.string("branch").pipe(Flag.optional),
  }).pipe(
    Command.withDescription("Start a thread and print its id."),
    Command.withHandler((flags) =>
      run(
        async (call, prompt) => {
          const { projects } = await call("f5_project_list", {}, projectsSchema);
          const project = await resolveCliProject(projects, flags.project);
          const sent = await call(
            "f5_thread_launch",
            {
              projectId: project.id,
              prompt,
              title: Option.getOrElse(flags.title, () =>
                prompt.trim().split("\n")[0]!.slice(0, 80),
              ),
              ...Object.fromEntries(
                ["provider", "model", "worktree", "branch"].flatMap((key) => {
                  const value = Option.getOrUndefined(
                    flags[key as "provider" | "model" | "worktree" | "branch"],
                  );
                  return value === undefined ? [] : [[key, value]];
                }),
              ),
            },
            submittedSchema,
          );
          if (flags.wait) {
            if (!flags.json) console.error("Thread " + sent.threadId);
            await finishCliSubmission(call, sent, flags.json);
          } else if (flags.json) print(sent);
          else console.log(sent.threadId);
        },
        () => readCliMessage(flags.message),
      ),
    ),
  );
  const send = Command.make("send", { thread, message, json, wait }).pipe(
    Command.withDescription("Queue a message without interrupting running work."),
    Command.withHandler((flags) =>
      run(
        async (call, prompt) => {
          const sent = await call(
            "f5_thread_send",
            { threadId: flags.thread, prompt },
            submittedSchema,
          );
          if (flags.wait) await finishCliSubmission(call, sent, flags.json);
          else if (flags.json) print(sent);
          else console.log(sent.delivery === "started" ? "Sent." : "Queued.");
        },
        () => readCliMessage(flags.message),
      ),
    ),
  );
  const show = Command.make("show", {
    thread,
    json,
    messages: Flag.integer("messages").pipe(Flag.withDefault(10)),
  }).pipe(
    Command.withDescription("Show a thread and its latest messages."),
    Command.withHandler((flags) =>
      run(async (call) => {
        const result = await readCliThread(call, flags.thread, flags.messages);
        if (flags.json) return print(result);
        console.log(result.thread.title + "\n" + result.thread.id + "  " + result.thread.status);
        console.log(
          (result.thread.provider ?? "?") +
            "/" +
            result.thread.model +
            "  " +
            result.thread.runtimeMode,
        );
        if (result.thread.worktreePath)
          console.log((result.thread.branch ?? "(no branch)") + "  " + result.thread.worktreePath);
        if (result.thread.pendingRequestCount > 0)
          console.log("Waiting for " + result.thread.pendingRequestCount + " answer(s).");
        for (const message of result.messages)
          console.log("\n[" + message.role + "]\n" + message.text);
      }),
    ),
  );
  const list = Command.make("list", {
    json,
    project: Flag.string("project").pipe(Flag.withDefault(".")),
    limit: Flag.integer("limit").pipe(Flag.withDefault(100)),
  }).pipe(
    Command.withDescription("List a project's threads, newest first."),
    Command.withHandler((flags) =>
      run(async (call) => {
        const { projects } = await call("f5_project_list", {}, projectsSchema);
        const project = await resolveCliProject(projects, flags.project);
        const { threads } = await call(
          "f5_thread_list",
          { projectId: project.id, limit: flags.limit },
          threadsSchema,
        );
        if (flags.json) return print(threads);
        for (const thread of threads)
          console.log(thread.id + "  " + thread.status + "  " + thread.title);
      }),
    ),
  );
  return Command.make("thread").pipe(
    Command.withDescription("Start, message, and read threads on the running F5 server."),
    Command.withSubcommands([start, send, show, list]),
  );
}
