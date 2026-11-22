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
  antigravityProfileDirectory,
} from "../provider/acp/AntigravityAcpSupport.ts";
import {
  ANTIGRAVITY_PERSONAL_AUTH,
  advanceAntigravityRevision,
  antigravityKeyFingerprint,
  reconcileAntigravityAuthState,
  redactAntigravityKey,
  type AntigravityAuthConfig,
} from "../provider/antigravityAuthSupport.ts";

// A healthy agent shows the Google link within seconds. Its bundled Python has no IPv4
// fallback race, so a host with broken IPv6 waits about two minutes per Google request.
const NO_RESPONSE_HINT_MS = 30_000;
const NO_RESPONSE_MESSAGE =
  "Antigravity has not reached Google after 30 seconds. Check this machine's network connection. Broken IPv6 is a common cause.";

/** One account job. Existing RPC requests map onto these in `ProviderAccountService`. */
export type AntigravityAccountAction =
  | { readonly type: "install" }
  | { readonly type: "oauth-connect" }
  | { readonly type: "key-connect" }
  | { readonly type: "disconnect" };

/** Fits the existing owner-scoped account job and lease lifecycle without creating a shell. */
export function createAntigravityAccountProcess(input: {
  stateDir: string;
  instanceId: string;
  action: AntigravityAccountAction;
  environment: NodeJS.ProcessEnv;
  auth?: AntigravityAuthConfig;
}): PtyProcess {
  const auth = input.auth ?? ANTIGRAVITY_PERSONAL_AUTH;
  const profileDirectory = antigravityProfileDirectory(input.stateDir, input.instanceId);
  const action = input.action.type;
  const controller = new AbortController();
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExitEvent) => void>();
  let exited: PtyExitEvent | undefined;
  const emit = (data: string) => {
    const safe = redactAntigravityKey(data, auth.apiKey);
    for (const listener of dataListeners) listener(safe);
  };
  let authorizationUrlShown = false;
  let noResponseHint: ReturnType<typeof setTimeout> | undefined;
  let login: ChildProcessWithoutNullStreams | undefined;
  let inputBuffer = "";
  const codeLogin = async () => {
    const prepared = await prepareAntigravityProfile({
      ...input,
      auth: ANTIGRAVITY_PERSONAL_AUTH,
      accountSetup: true,
    });
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
  /** A disposable ACP process: initialize, then one account request. Never starts a session. */
  const accountRequest = (method: "authenticate" | "logout", params: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        // A never-enabled instance has no profile folder yet.
        yield* Effect.promise(() => fs.mkdir(profileDirectory, { recursive: true, mode: 0o700 }));
        const temporary = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(profileDirectory, ".account-"))),
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        );
        const runtime = yield* makeAntigravityAcpRuntime({
          ...input,
          auth,
          childProcessSpawner: spawner,
          cwd: temporary,
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
        yield* runtime.request(method, params);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { signal: controller.signal },
    );
  const keyConnect = async () => {
    if (!auth.apiKey) throw new Error("Enter a Gemini API key in Settings first.");
    await accountRequest("authenticate", { methodId: "gemini-api-key" });
    await advanceAntigravityRevision(profileDirectory, () => ({
      method: "gemini-api-key",
      keyFingerprint: antigravityKeyFingerprint(auth.apiKey),
      verified: true,
      // A successful connect is one of the two explicit model-discovery triggers.
      discoveryRequested: true,
    }));
    emit("Antigravity accepted the Gemini API key.\n");
  };
  const oauthConnect = async () => {
    await codeLogin();
    // Record the new account fingerprint first; the revision advances either way.
    await reconcileAntigravityAuthState(profileDirectory, ANTIGRAVITY_PERSONAL_AUTH);
    await advanceAntigravityRevision(profileDirectory, () => ({
      method: "oauth-personal",
      verified: true,
      discoveryRequested: true,
    }));
  };
  const disconnect = async () => {
    if (auth.authMethod === "oauth-personal") {
      await accountRequest("logout", {});
      await fs.rm(path.join(profileDirectory, "antigravity-acp", "acp_token.json"), {
        force: true,
      });
    }
    // The stored key itself is cleared by the account service through settings.
    // `undefined` fields clear the merged values; JSON omits them.
    await advanceAntigravityRevision(profileDirectory, () => ({
      keyFingerprint: undefined,
      accountFingerprint: undefined,
      verified: false,
    }));
  };
  // AccountService registers its handlers in the same turn before this starts.
  queueMicrotask(() => {
    if (action === "oauth-connect")
      noResponseHint = setTimeout(() => {
        if (!authorizationUrlShown && !exited) emit(`${NO_RESPONSE_MESSAGE}\n`);
      }, NO_RESPONSE_HINT_MS);
    const operation =
      action === "install"
        ? (async () => {
            const installation = new AntigravityInstallation(input.stateDir);
            const previous = await installation.resolve().catch(() => undefined);
            const result = await installation.install(controller.signal);
            emit(
              previous?.version === result.version
                ? "Antigravity " + result.version + " is already up to date.\n"
                : "Antigravity " + result.version + (previous ? " updated.\n" : " installed.\n"),
            );
          })()
        : action === "oauth-connect"
          ? oauthConnect()
          : action === "key-connect"
            ? keyConnect()
            : disconnect();
    void operation
      .then(
        () => {
          exited = { exitCode: 0, signal: null };
        },
        async (error) => {
          // A sign-in or sign-out may have changed credentials before failing.
          if (action === "oauth-connect" || action === "disconnect")
            await advanceAntigravityRevision(profileDirectory, (state) => ({
              ...state,
              verified: false,
            })).catch(() => undefined);
          // Transport causes can contain credentials. Only actionable, fixed errors reach the UI.
          emit(
            controller.signal.aborted
              ? "Account setup cancelled.\n"
              : action === "install"
                ? `Installation failed: ${error instanceof Error ? error.message : "download failed"}\n`
                : action === "key-connect"
                  ? "Antigravity did not accept this Gemini API key. Check the key and retry Connect.\n"
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
      if (!login || action !== "oauth-connect")
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
