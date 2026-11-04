import { expect, it } from "vitest";
import {
  BROWSER_OPEN_TOKEN_ENV,
  browserOpenThreadFor,
  browserOpenTokenFor,
  withBrowserOpenThreadToken,
} from "./BrowserOpenThreadToken";

it("keeps one unguessable token per thread and resolves it back", () => {
  const first = browserOpenTokenFor("thread-a");
  expect(first).toMatch(/^[\w-]{32}$/);
  expect(browserOpenTokenFor("thread-a")).toBe(first);
  expect(browserOpenTokenFor("thread-b")).not.toBe(first);
  expect(browserOpenThreadFor(first)).toBe("thread-a");
  expect(browserOpenThreadFor("unknown")).toBeUndefined();
  expect(browserOpenThreadFor(42)).toBeUndefined();
});

it("replaces an inherited token with the thread's own and never sets one when disabled", () => {
  const inherited = { PATH: "/bin", [BROWSER_OPEN_TOKEN_ENV]: "other-thread" };
  expect(withBrowserOpenThreadToken(inherited, "thread-c", true)).toEqual({
    PATH: "/bin",
    [BROWSER_OPEN_TOKEN_ENV]: browserOpenTokenFor("thread-c"),
  });
  expect(withBrowserOpenThreadToken(inherited, "thread-c", false)).toEqual({ PATH: "/bin" });
  expect(withBrowserOpenThreadToken(inherited, undefined, true)).toEqual({ PATH: "/bin" });
  // The caller's environment is left untouched.
  expect(inherited[BROWSER_OPEN_TOKEN_ENV]).toBe("other-thread");
});
