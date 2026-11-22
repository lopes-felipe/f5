import { Effect } from "effect";
import * as AcpErrors from "effect-acp/errors";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  onAuthorizationUrl: undefined as ((url: string) => void) | undefined,
  stdin: vi.fn(),
  requests: [] as Array<{ method: string; params: unknown }>,
  authenticateSucceeds: false,
  authenticateRejects: false,
  update: vi.fn(
    async (
      _profileDirectory: string,
      _update: (state: {
        version: 1;
        revision: number;
        verified: boolean;
        method?: string;
        keyFingerprint?: string;
      }) => unknown,
    ) => ({ version: 1, revision: 1, verified: true }),
  ),
  advance: vi.fn(
    async (
      _profileDirectory: string,
      _patch?: (state: {
        version: 1;
        revision: number;
        verified: boolean;
        keyFingerprint?: string;
        accountFingerprint?: string;
      }) => unknown,
    ) => ({ version: 1, revision: 1, verified: true }),
  ),
}));

const fsCalls = vi.hoisted(() => ({ mkdir: [] as string[] }));
vi.mock("node:fs/promises", () => ({
  mkdir: async (directory: string) => {
    fsCalls.mkdir.push(directory);
  },
  mkdtemp: async () => "/tmp/f5-login-test",
  rm: async () => {},
}));
vi.mock("node:child_process", () => ({
  spawn: (_command: string, _args: string[], options: { signal: AbortSignal }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: { write: runtime.stdin },
    });
    runtime.onAuthorizationUrl = (url) =>
      child.stdout.emit("data", Buffer.from("Open this URL to sign in:\n" + url));
    options.signal.addEventListener("abort", () => child.emit("close", 1), { once: true });
    return child;
  },
}));
vi.mock("../provider/acp/AntigravityAcpSupport.ts", () => ({
  prepareAntigravityProfile: async () => ({
    home: "/tmp/f5-profile",
    executable: { executablePath: "/synthetic/agy" },
    browser: "/synthetic/browser",
  }),
  antigravityEnvironment: () => ({}),
  antigravityProfileDirectory: () => "/tmp/f5-profile",
  makeAntigravityAcpRuntime: (input: { onAuthorizationUrl?: (url: string) => void }) => {
    runtime.onAuthorizationUrl = input.onAuthorizationUrl;
    return Effect.succeed({
      request: (method: string, params: unknown) => {
        runtime.requests.push({ method, params });
        if (method === "authenticate" && runtime.authenticateRejects)
          return Effect.fail(
            new AcpErrors.AcpRequestError({ code: -32000, errorMessage: "invalid key" }),
          );
        return method === "authenticate" && !runtime.authenticateSucceeds
          ? Effect.never
          : Effect.void;
      },
    });
  },
}));
vi.mock("../provider/antigravityAuthSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  advanceAntigravityRevision: runtime.advance,
  updateAntigravityAuthState: runtime.update,
  reconcileAntigravityAuthState: async () => ({ version: 1, revision: 0, verified: false }),
}));

const { createAntigravityAccountProcess } = await import("./AntigravityAccountProcess.ts");

const NO_RESPONSE = "Antigravity has not reached Google after 30 seconds";

const start = (
  action: "oauth-connect" | "key-connect" | "disconnect" = "oauth-connect",
  auth?: { authMethod: "oauth-personal" | "gemini-api-key"; apiKey: string },
) => {
  const output: string[] = [];
  const child = createAntigravityAccountProcess({
    stateDir: "/tmp/f5-antigravity-account-test",
    instanceId: "antigravity",
    action: { type: action },
    environment: {},
    ...(auth ? { auth } : {}),
  });
  child.onData((data) => output.push(data));
  return { child, output };
};

beforeEach(() => {
  vi.useFakeTimers();
  runtime.onAuthorizationUrl = undefined;
  runtime.stdin.mockClear();
  runtime.requests = [];
  runtime.authenticateSucceeds = false;
  runtime.authenticateRejects = false;
  runtime.advance.mockClear();
  runtime.update.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

it("says when sign-in has not reached Google after 30 seconds", async () => {
  const { child, output } = start();
  await vi.advanceTimersByTimeAsync(29_000);
  expect(output.join("")).not.toContain(NO_RESPONSE);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(output.join("")).toContain("Broken IPv6 is a common cause.");
  child.kill();
});

it("stays quiet once the Google link was shown", async () => {
  const { child, output } = start();
  await vi.advanceTimersByTimeAsync(1_000);
  runtime.onAuthorizationUrl?.("https://accounts.google.com/o/oauth2/auth?state=1");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(output.join("")).toContain("Open this URL to sign in:");
  expect(output.join("")).not.toContain(NO_RESPONSE);
  child.kill();
});

it("sends only a submitted sign-in code to the CLI and does not echo it", async () => {
  const { child, output } = start();
  await vi.advanceTimersByTimeAsync(1);
  child.write("secret");
  expect(runtime.stdin).not.toHaveBeenCalled();
  child.write("-code\n");
  expect(runtime.stdin).toHaveBeenCalledWith("secret-code\n");
  expect(output.join("")).not.toContain("secret-code");
  child.kill();
});

it("verifies a Gemini API key through a disposable authenticate and records the revision", async () => {
  runtime.authenticateSucceeds = true;
  const key = "AIzaSy-test-key-0123456789";
  const { child, output } = start("key-connect", { authMethod: "gemini-api-key", apiKey: key });
  const exited = new Promise<number>((resolve) => child.onExit((event) => resolve(event.exitCode)));
  await vi.advanceTimersByTimeAsync(1);
  expect(await exited).toBe(0);
  expect(runtime.requests.map((request) => request.method)).toEqual(["initialize", "authenticate"]);
  expect(runtime.requests[1]?.params).toEqual({ methodId: "gemini-api-key" });
  expect(runtime.update).toHaveBeenCalledTimes(1);
  // A never-enabled instance gets its profile folder before the account workspace.
  expect(fsCalls.mkdir).toHaveLength(1);
  expect(output.join("")).toContain("Antigravity accepted the Gemini API key.");
  const update = runtime.update.mock.calls[0]![1];
  // A new key advances the revision and requests one model discovery.
  expect(update({ version: 1, revision: 4, verified: false })).toEqual(
    expect.objectContaining({ revision: 5, verified: true, discoveryRequested: true }),
  );
  // Reconnecting the same key keeps the revision, so threads keep their native sessions.
  const { antigravityKeyFingerprint } = await import("../provider/antigravityAuthSupport.ts");
  expect(
    update({
      version: 1,
      revision: 4,
      verified: false,
      method: "gemini-api-key",
      keyFingerprint: antigravityKeyFingerprint(key),
    }),
  ).toEqual(expect.objectContaining({ revision: 4, verified: true }));
  expect(output.join("")).not.toContain(key);
});

it("clears an earlier verification when Antigravity rejects the same key", async () => {
  runtime.authenticateRejects = true;
  const key = "AIzaSy-test-key-0123456789";
  const { child, output } = start("key-connect", { authMethod: "gemini-api-key", apiKey: key });
  const exited = new Promise<number>((resolve) => child.onExit((event) => resolve(event.exitCode)));
  await vi.advanceTimersByTimeAsync(1);
  expect(await exited).toBe(1);
  expect(output.join("")).toContain("did not accept this Gemini API key");
  const { antigravityKeyFingerprint } = await import("../provider/antigravityAuthSupport.ts");
  const update = runtime.update.mock.calls[0]![1];
  const fingerprint = antigravityKeyFingerprint(key);
  expect(update({ version: 1, revision: 2, verified: true, keyFingerprint: fingerprint })).toEqual(
    expect.objectContaining({ revision: 2, verified: false }),
  );
  // A different key saved since is left alone.
  expect(update({ version: 1, revision: 2, verified: true, keyFingerprint: "other" })).toEqual(
    expect.objectContaining({ verified: true }),
  );
});

it("signs out of a key instance without an ACP logout and advances the revision", async () => {
  const { child } = start("disconnect", { authMethod: "gemini-api-key", apiKey: "k".repeat(20) });
  const exited = new Promise<number>((resolve) => child.onExit((event) => resolve(event.exitCode)));
  await vi.advanceTimersByTimeAsync(1);
  expect(await exited).toBe(0);
  expect(runtime.requests).toEqual([]);
  expect(runtime.advance).toHaveBeenCalledTimes(1);
  // The disconnect clears the stored fingerprints instead of merging the old ones back.
  const patch = runtime.advance.mock.calls[0]?.[1]?.({
    version: 1,
    revision: 3,
    verified: true,
    keyFingerprint: "old-key",
    accountFingerprint: "old-account",
  });
  expect(patch).toEqual({
    keyFingerprint: undefined,
    accountFingerprint: undefined,
    verified: false,
  });
});
