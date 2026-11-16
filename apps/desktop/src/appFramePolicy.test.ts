import { beforeEach, expect, it } from "vitest";

import {
  allowsAppPermission,
  createEmbeddedFrameNavigationGuard,
  installAppFramePermissionPolicy,
} from "./appFramePolicy";

let guard = createEmbeddedFrameNavigationGuard();
beforeEach(() => {
  guard = createEmbeddedFrameNavigationGuard();
});
const navigation = (
  frameUrl: string | undefined,
  url: string,
  options: { isMainFrame?: boolean; isSameDocument?: boolean; frameIds?: number[] } = {},
) => ({
  isMainFrame: options.isMainFrame ?? false,
  isSameDocument: options.isSameDocument ?? false,
  frameIds: options.frameIds ?? [1],
  frameUrl,
  url,
});

it("keeps an HTML render or MCP app from navigating its frame anywhere else", () => {
  // Script navigation, a meta refresh and a form submission all reach this as a frame navigation.
  expect(guard(navigation("about:srcdoc", "https://attacker.example/?d=1"))).toBe(true);
  expect(guard(navigation("about:srcdoc", "data:text/html,x"))).toBe(true);
  expect(guard(navigation("about:srcdoc", "f5://new?prompt=x"))).toBe(true);
});

it("still blocks the frame after it changes its own URL first", () => {
  // `location.hash = "x"` is a same-document navigation, and the frame's URL becomes
  // about:srcdoc#x.
  expect(guard(navigation("about:srcdoc", "about:srcdoc#x", { isSameDocument: true }))).toBe(false);
  expect(guard(navigation("about:srcdoc#x", "https://attacker.example/?d=1"))).toBe(true);
  // Leaving for about:blank is allowed, but the frame stays protected there.
  expect(guard(navigation("about:srcdoc", "about:blank", { frameIds: [2] }))).toBe(false);
  expect(guard(navigation("about:blank", "https://attacker.example/", { frameIds: [2] }))).toBe(
    true,
  );
  // So is a frame nested in a protected one.
  expect(guard(navigation("about:blank", "https://attacker.example/", { frameIds: [3, 2] }))).toBe(
    true,
  );
});

it("lets a frame load its own document and leaves other frames and the app alone", () => {
  expect(guard(navigation(undefined, "about:srcdoc"))).toBe(false);
  expect(guard(navigation("about:blank", "about:srcdoc", { frameIds: [4] }))).toBe(false);
  expect(guard(navigation("about:srcdoc", "about:srcdoc"))).toBe(false);
  expect(guard(navigation("about:srcdoc", "about:srcdoc#section", { isSameDocument: true }))).toBe(
    false,
  );
  // Workspace media frames load server asset URLs.
  expect(guard(navigation("", "http://127.0.0.1:3773/api/assets/x.pdf", { frameIds: [5] }))).toBe(
    false,
  );
  expect(guard(navigation("about:srcdoc", "https://example.com/", { isMainFrame: true }))).toBe(
    false,
  );
});

it("denies embedded frames the camera, microphone and location but keeps the app's own", () => {
  for (const permission of ["media", "geolocation", "notifications", "clipboard-read"]) {
    expect(allowsAppPermission(permission, { isMainFrame: false })).toBe(false);
    expect(allowsAppPermission(permission, { isMainFrame: true })).toBe(true);
  }
  expect(allowsAppPermission("clipboard-sanitized-write", { isMainFrame: false })).toBe(true);
});

it("installs both handlers once per session", () => {
  const calls: string[] = [];
  let request: ((permission: string, isMainFrame: boolean) => boolean) | undefined;
  const session = {
    setPermissionRequestHandler: (
      handler: (
        contents: unknown,
        permission: string,
        callback: (granted: boolean) => void,
        details: { isMainFrame?: boolean },
      ) => void,
    ) => {
      calls.push("request");
      request = (permission, isMainFrame) => {
        let granted = true;
        handler(null, permission, (value) => (granted = value), { isMainFrame });
        return granted;
      };
    },
    setPermissionCheckHandler: () => calls.push("check"),
  };
  installAppFramePermissionPolicy(session);
  installAppFramePermissionPolicy(session);
  expect(calls).toEqual(["request", "check"]);
  expect(request?.("media", false)).toBe(false);
  expect(request?.("media", true)).toBe(true);
});
