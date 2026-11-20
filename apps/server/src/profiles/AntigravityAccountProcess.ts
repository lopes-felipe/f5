import { Effect } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PtyProcess, PtyExitEvent } from "../terminal/Services/PTY.ts";
import { AntigravityInstallation } from "../provider/AntigravityInstallation.ts";
import {
  makeAntigravityAcpRuntime,
  prepareAntigravityProfile,
  antigravityEnvironment,
} from "../provider/acp/AntigravityAcpSupport.ts";

// A healthy agent shows the Google link within seconds. Its bundled Python has no IPv4
// fallback race, so a host with broken IPv6 waits about two minutes per Google request.
const NO_RESPONSE_HINT_MS = 30_000;
const NO_RESPONSE_MESSAGE =
  "Antigravity has not reached Google after 30 seconds. Check this machine's network connection. Broken IPv6 is a common cause.";

/** Fits the existing owner-scoped account job and lease lifecycle without creating a shell. */
export function createAntigravityAccountProcess(input: {
  stateDir: string;
  instanceId: string;
  action: "install" | "login" | "logout";
  environment: NodeJS.ProcessEnv;
}): PtyProcess {
  const controller = new AbortController();
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  let exited: PtyExitEvent | undefined;
  const emit = (data: string) => {
    for (const listener of dataListeners) listener(data);
  };
  let authorizationUrlShown = false;
  let noResponseHint: ReturnType<typeof setTimeout> | undefined;
  let login: ChildProcessWithoutNullStreams | undefined;
  let inputBuffer = "";
  const codeLogin = async () => {
    const prepared = await prepareAntigravityProfile({ ...input, accountSetup: true });
    const temporary = await fs.mkdtemp(path.join(prepared.home, ".login-"));
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          prepared.executable.executablePath,
          ["acp", "--login", "--gemini-dir", prepared.home, "--app-data-dir", "antigravity-acp"],
          {
            cwd: temporary,
            stdio: "pipe",
            signal: controller.signal,
            env: {
              ...antigravityEnvironment(
                input.environment,
                prepared.home,
                undefined,
                prepared.browser,
              ),
              TMPDIR: temporary,
              TMP: temporary,
              TEMP: temporary,
            },
          },
        );
        login = child;
        const output = (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          if (text.includes("https://accounts.google.com/")) authorizationUrlShown = true;
          emit(text);
        };
        child.stdout.on("data", output);
        child.stderr.on("data", output);
        let failure: Error | undefined;
        child.once("error", (error) => {
          failure = error;
        });
        child.once("close", (code) =>
          code === 0 && !failure
            ? resolve()
            : reject(failure ?? new Error("Antigravity sign-in failed.")),
        );
      });
    } finally {
      login = undefined;
      await fs.rm(temporary, { recursive: true, force: true });
    }
  };
  // AccountService registers its handlers in the same turn before this starts.
  queueMicrotask(() => {
    if (input.action === "login")
      noResponseHint = setTimeout(() => {
        if (!authorizationUrlShown && !exited) emit(`${NO_RESPONSE_MESSAGE}\n`);
      }, NO_RESPONSE_HINT_MS);
    const operation =
      input.action === "install"
        ? new AntigravityInstallation(input.stateDir).install(controller.signal).then(() => {
            emit("Antigravity installed. Sign in to continue.\n");
          })
        : input.action === "login"
          ? codeLogin()
          : Effect.runPromise(
              Effect.gen(function* () {
                const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                const runtime = yield* makeAntigravityAcpRuntime({
                  ...input,
                  childProcessSpawner: spawner,
                  cwd: input.stateDir,
                  accountSetup: true,
                  onAuthorizationUrl: (url) => {
                    authorizationUrlShown = true;
                    emit(`Open this URL to sign in:\n${url}\n`);
                  },
                });
                yield* runtime.request("initialize", {
                  protocolVersion: 1,
                  clientCapabilities: {},
                  clientInfo: { name: "f5-account", version: "1" },
                });
                yield* runtime.request(
                  input.action === "logout" ? "logout" : "authenticate",
                  input.action === "logout" ? {} : { methodId: "oauth-personal" },
                );
              }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
              { signal: controller.signal },
            );
    void operation
      .then(
        () => {
          exited = { exitCode: 0, signal: null };
        },
        (error) => {
          // Transport causes can contain credentials. Only actionable, fixed errors reach the UI.
          emit(
            controller.signal.aborted
              ? "Account setup cancelled.\n"
              : input.action === "install"
                ? `Installation failed: ${error instanceof Error ? error.message : "download failed"}\n`
                : "Antigravity account setup failed. Retry sign-in, or check that the installed release can start.\n",
          );
          exited = { exitCode: 1, signal: null };
        },
      )
      .finally(() => {
        clearTimeout(noResponseHint);
        for (const listener of exitListeners) listener(exited!);
      });
  });
  return {
    pid: 0,
    write(data) {
      if (!login || input.action !== "login")
        throw new Error("Wait for the Antigravity sign-in prompt.");
      // Terminals may send one character at a time. Send only the submitted code.
      inputBuffer = (inputBuffer + data).slice(-4096);
      const newline = inputBuffer.search(/[\r\n]/);
      if (newline < 0) return;
      const code = inputBuffer.slice(0, newline).trim();
      inputBuffer = "";
      if (!code || /[\x00-\x20\x7f]/.test(code))
        throw new Error("Paste the code shown by Antigravity.");
      login.stdin.write(code + "\n");
    },
    resize() {},
    kill() {
      controller.abort();
    },
    onData(callback) {
      dataListeners.add(callback);
      return () => {
        dataListeners.delete(callback);
      };
    },
    onExit(callback) {
      exitListeners.add(callback);
      if (exited) queueMicrotask(() => callback(exited!));
      return () => {
        exitListeners.delete(callback);
      };
    },
  };
}
