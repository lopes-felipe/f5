import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Deferred, Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as AcpErrors from "effect-acp/errors";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "./AcpSessionRuntime.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";

async function publishProfileFile(file: string, contents: string): Promise<void> {
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

export function antigravityProfileDirectory(stateDir: string, instanceId: string): string {
  return path.join(
    stateDir,
    "providers",
    "antigravity",
    "accounts",
    createHash("sha256").update(instanceId).digest("hex"),
  );
}

const credentialVariables =
  /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_OAUTH_ACCESS_TOKEN|AGY_ACP_.*|GEMINI_HOME|ANTIGRAVITY_HARNESS_PATH|BROWSER|ELECTRON_RUN_AS_NODE)$/i;
export function antigravityEnvironment(
  base: NodeJS.ProcessEnv,
  home: string,
  harness: string,
  browserCommand: string,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !credentialVariables.test(key))),
    GEMINI_HOME: home,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ANTIGRAVITY_HARNESS_PATH: harness,
    BROWSER: browserCommand,
    PYTHONUNBUFFERED: "1",
  };
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

export const makeAntigravityAcpRuntime = (input: {
  stateDir: string;
  instanceId: string;
  environment: NodeJS.ProcessEnv;
  childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  cwd: string;
  resumeSessionId?: string;
  accountSetup?: boolean;
  onAuthorizationUrl?: (url: string) => void;
}): Effect.Effect<AcpSessionRuntimeShape, AcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.tryPromise({
      try: async () => {
        const executable = await new AntigravityInstallation(input.stateDir).resolve();
        const home = antigravityProfileDirectory(input.stateDir, input.instanceId);
        await fs.mkdir(path.join(home, "antigravity-acp"), { recursive: true, mode: 0o700 });
        if (!input.accountSetup) {
          const token = await fs.lstat(path.join(home, "antigravity-acp", "acp_token.json"));
          if (!token.isFile() || token.size === 0)
            throw new Error("Sign in to Antigravity in Settings first.");
        }
        await publishProfileFile(
          path.join(home, "antigravity-acp", "settings.json"),
          JSON.stringify({ auth: { type: "oauth-personal" } }),
        );
        const userHome =
          process.platform === "win32"
            ? input.environment.USERPROFILE || os.homedir()
            : input.environment.HOME || os.homedir();
        // Share only user skill directories. MCP, hooks and credentials remain private.
        for (const directory of ["config", "antigravity-cli"]) {
          const source = path.join(userHome, ".gemini", directory, "skills");
          const target = path.join(home, directory, "skills");
          try {
            if (!(await fs.stat(source)).isDirectory()) continue;
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
          } catch (error) {
            if (
              !(
                error &&
                typeof error === "object" &&
                "code" in error &&
                ["ENOENT", "EEXIST"].includes(String(error.code))
              )
            )
              throw error;
          }
        }
        // A helper handles browser requests without opening a browser in the server account.
        const helper = path.join(home, "browser.cjs");
        await publishProfileFile(
          helper,
          'process.stderr.on("error",()=>process.exit(0));process.stderr.write("F5_AUTH_URL="+JSON.stringify(process.argv[2])+"\\n");',
        );
        const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
        const wrapper = path.join(
          home,
          process.platform === "win32" ? "browser.cmd" : "browser.sh",
        );
        const script =
          process.platform === "win32"
            ? `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath.replaceAll("%", "%%")}" "${helper.replaceAll("%", "%%")}" %1\r\n`
            : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(helper)} "$1"\n`;
        await publishProfileFile(wrapper, script);
        await fs.chmod(wrapper, 0o700);
        // Python webbrowser shlex-splits commands containing %s, including quoted paths.
        const browser = `${quote(wrapper)} %s`;
        return { executable, home, browser };
      },
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
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        resumeMethod: "resume",
        authMethodId: "oauth-personal",
        clientInfo: { name: "f5", version: "1" },
        hardening: { enabled: true, provider: "antigravity" },
        clientCapabilities: { elicitation: { form: {} } },
        spawn: {
          command: prepared.executable.executablePath,
          args: process.platform === "linux" ? ["--uid="] : [],
          cwd: input.cwd,
          env: {
            ...antigravityEnvironment(
              input.environment,
              prepared.home,
              prepared.executable.harnessPath,
              prepared.browser,
            ),
            TMPDIR: tempDirectory,
            TMP: tempDirectory,
            TEMP: tempDirectory,
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
        sanitizeStderr: (text) => text.replace(/https:\/\/[^\s"<>]+/g, "[URL redacted]"),
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
    return {
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
  });
