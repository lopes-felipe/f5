import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  onAuthorizationUrl: undefined as ((url: string) => void) | undefined,
}));

vi.mock("../provider/acp/AntigravityAcpSupport.ts", () => ({
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
