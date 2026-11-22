import { Effect } from "effect";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  onAuthorizationUrl: undefined as ((url: string) => void) | undefined,
  stdin: vi.fn(),
  requests: [] as Array<{ method: string; params: unknown }>,
  authenticateSucceeds: false,
  advance: vi.fn(
    async (
      _profileDirectory: string,
      _patch?: (state: { version: 1; revision: number; verified: boolean }) => unknown,
    ) => ({ version: 1, revision: 1, verified: true }),
  ),
}));

vi.mock("node:fs/promises", () => ({
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
  runtime.advance.mockClear();
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
  expect(runtime.advance).toHaveBeenCalledTimes(1);
  expect(output.join("")).toContain("Antigravity accepted the Gemini API key.");
  // A successful connect requests one model discovery.
  expect(
    runtime.advance.mock.calls[0]?.[1]?.({ version: 1, revision: 0, verified: false }),
  ).toEqual(expect.objectContaining({ verified: true, discoveryRequested: true }));
  expect(output.join("")).not.toContain(key);
});

it("signs out of a key instance without an ACP logout and advances the revision", async () => {
  const { child } = start("disconnect", { authMethod: "gemini-api-key", apiKey: "k".repeat(20) });
  const exited = new Promise<number>((resolve) => child.onExit((event) => resolve(event.exitCode)));
  await vi.advanceTimersByTimeAsync(1);
  expect(await exited).toBe(0);
  expect(runtime.requests).toEqual([]);
  expect(runtime.advance).toHaveBeenCalledTimes(1);
});
