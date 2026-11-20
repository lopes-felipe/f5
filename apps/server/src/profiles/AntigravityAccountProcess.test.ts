import { Effect } from "effect";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  onAuthorizationUrl: undefined as ((url: string) => void) | undefined,
  stdin: vi.fn(),
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
  makeAntigravityAcpRuntime: (input: { onAuthorizationUrl?: (url: string) => void }) => {
    runtime.onAuthorizationUrl = input.onAuthorizationUrl;
    return Effect.succeed({
      request: (method: string) => (method === "authenticate" ? Effect.never : Effect.void),
    });
  },
}));

const { createAntigravityAccountProcess } = await import("./AntigravityAccountProcess.ts");

const NO_RESPONSE = "Antigravity has not reached Google after 30 seconds";

const start = (action: "login" | "logout" = "login") => {
  const output: string[] = [];
  const child = createAntigravityAccountProcess({
    stateDir: "/tmp/f5-antigravity-account-test",
    instanceId: "antigravity",
    action,
    environment: {},
  });
  child.onData((data) => output.push(data));
  return { child, output };
};

beforeEach(() => {
  vi.useFakeTimers();
  runtime.onAuthorizationUrl = undefined;
  runtime.stdin.mockClear();
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
