import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PtyProcess, PtyExitEvent } from "../terminal/Services/PTY.ts";
import { AntigravityInstallation } from "../provider/AntigravityInstallation.ts";
import { makeAntigravityAcpRuntime } from "../provider/acp/AntigravityAcpSupport.ts";

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
  // AccountService registers its handlers in the same turn before this starts.
  queueMicrotask(() => {
    const operation =
      input.action === "install"
        ? new AntigravityInstallation(input.stateDir).install(controller.signal).then(() => {
            emit("Antigravity installed. Sign in to continue.\n");
          })
        : Effect.runPromise(
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const runtime = yield* makeAntigravityAcpRuntime({
                ...input,
                childProcessSpawner: spawner,
                cwd: input.stateDir,
                accountSetup: true,
                onAuthorizationUrl: (url) => emit(`Open this URL to sign in:\n${url}\n`),
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
        for (const listener of exitListeners) listener(exited!);
      });
  });
  return {
    pid: 0,
    write() {
      throw new Error("Use the browser link to complete Antigravity sign-in.");
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
