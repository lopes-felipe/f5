import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";

import { installPreviewPermissionPolicy } from "./previewPermissions";
import { previewLocationPromptOptions } from "./locationPrompt";

it("requires reassessing the loopback permission check when upgrading Electron", () => {
  // A granted check can itself authorize some APIs without a later permission request.
  // This compatibility grant is safe only while Electron disables LNA enforcement.
  // Verified in v44.10.1 shell/browser/feature_list.cc (disabled features list).
  const electron = createRequire(import.meta.url)("electron/package.json") as { version: string };
  expect(
    electron.version,
    "Reassess LocalNetworkAccessChecks and the loopback grant on Electron upgrade",
  ).toBe("44.10.1");
});

it("allows clipboard writes and fullscreen, but only reports loopback access without granting requests", () => {
  let request:
    | ((contents: unknown, permission: string, done: (ok: boolean) => void) => void)
    | null = null;
  let check: ((contents: unknown, permission: string) => boolean) | null = null;
  const session = {
    setPermissionRequestHandler: vi.fn((handler: typeof request) => {
      request = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler: typeof check) => {
      check = handler;
    }),
  };
  installPreviewPermissionPolicy(session);
  installPreviewPermissionPolicy(session);
  expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);

  const granted = (permission: string) => {
    let result: boolean | undefined;
    request!({}, permission, (ok) => {
      result = ok;
    });
    return result;
  };
  for (const permission of ["clipboard-sanitized-write", "fullscreen"]) {
    expect(granted(permission)).toBe(true);
    expect(check!({}, permission)).toBe(true);
  }
  expect(granted("loopback-network")).toBe(false);
  expect(check!({}, "loopback-network")).toBe(true);
  for (const permission of [
    "openExternal",
    "clipboard-read",
    "notifications",
    "geolocation",
    "media",
    "local-fonts",
    "local-network",
    "local-network-access",
  ]) {
    expect(granted(permission)).toBe(false);
    expect(check!({}, permission)).toBe(false);
  }
  expect(check!({}, "clipboard-sanitized-write")).toBe(true);
  expect(check!({}, "media")).toBe(false);
});

it("lets the user's own local app use its camera and file pickers", () => {
  type Request = (
    contents: unknown,
    permission: string,
    done: (ok: boolean) => void,
    details?: { requestingUrl?: string },
  ) => void;
  let request: Request | null = null;
  let check: ((contents: unknown, permission: string, origin?: string) => boolean) | null = null;
  const userTab = { id: 1 };
  const agentTab = { id: 2 };
  installPreviewPermissionPolicy(
    {
      setPermissionRequestHandler: (handler: Request) => {
        request = handler;
      },
      setPermissionCheckHandler: (handler: typeof check) => {
        check = handler;
      },
    },
    { isUserDriven: (contents) => contents === userTab },
  );
  const granted = (contents: unknown, permission: string, requestingUrl: string) => {
    let result: boolean | undefined;
    request!(contents, permission, (ok) => (result = ok), { requestingUrl });
    return result;
  };
  for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000/", "http://app.localhost/"])
    expect(granted(userTab, "media", url)).toBe(true);
  expect(granted(userTab, "fileSystem", "http://[::1]:8080/")).toBe(true);
  expect(granted(userTab, "notifications", "http://localhost:5173/")).toBe(false);
  expect(check!(userTab, "notifications", "http://localhost:5173")).toBe(false);
  // A page the agent drives, a remote origin and an unlisted permission stay denied.
  expect(granted(agentTab, "media", "http://localhost:5173/")).toBe(false);
  expect(granted(userTab, "media", "https://example.com/")).toBe(false);
  expect(granted(userTab, "openExternal", "http://localhost:5173/")).toBe(false);
  expect(check!(null, "media", "http://localhost:5173")).toBe(false);
});

function geolocationPolicy(
  confirmGeolocation: (contents: { id: number }, origin: string) => Promise<boolean | undefined>,
) {
  const userTab = { id: 1 };
  const agentTab = { id: 2 };
  let driving = true;
  const session = {
    setPermissionRequestHandler:
      vi.fn<
        (
          handler: (
            contents: { id: number } | null,
            permission: string,
            done: (ok: boolean) => void,
            details?: { requestingUrl?: string },
          ) => void,
        ) => void
      >(),
    setPermissionCheckHandler:
      vi.fn<
        (
          handler: (
            contents: { id: number } | null,
            permission: string,
            origin?: string,
          ) => boolean,
        ) => void
      >(),
  };
  installPreviewPermissionPolicy(session, {
    isUserDriven: (contents) => driving && contents === userTab,
    confirmGeolocation: (contents, origin) =>
      contents ? confirmGeolocation(contents, origin) : Promise.resolve(undefined),
  });
  return {
    userTab,
    agentTab,
    stopDriving: () => (driving = false),
    startDriving: () => (driving = true),
    check: (origin: string, contents: { id: number } | null = userTab) =>
      session.setPermissionCheckHandler.mock.calls[0]![0](contents, "geolocation", origin),
    request: (url: string, contents: { id: number } | null = userTab) =>
      new Promise<boolean>((resolve) => {
        session.setPermissionRequestHandler.mock.calls[0]![0](contents, "geolocation", resolve, {
          requestingUrl: url,
        });
      }),
  };
}

it("remembers both geolocation choices per origin in the current session", async () => {
  const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  const preview = geolocationPolicy(confirm);
  expect(preview.check("http://localhost:5173")).toBe(false);
  expect(await preview.request("http://localhost:5173/page")).toBe(true);
  expect(await preview.request("http://localhost:5173/other")).toBe(true);
  expect(preview.check("http://localhost:5173")).toBe(true);
  expect(await preview.request("http://localhost:5180/")).toBe(false);
  expect(await preview.request("http://localhost:5180/other")).toBe(false);
  expect(preview.check("http://localhost:5180")).toBe(false);
  expect(confirm.mock.calls).toEqual([
    [preview.userTab, "http://localhost:5173"],
    [preview.userTab, "http://localhost:5180"],
  ]);
  expect(geolocationPolicy(confirm).check("http://localhost:5173")).toBe(false);
});

it("denies geolocation for ineligible tabs and origins even after an Allow", async () => {
  const confirm = vi.fn().mockResolvedValue(true);
  const preview = geolocationPolicy(confirm);
  expect(await preview.request("http://localhost:5173/")).toBe(true);
  expect(await preview.request("http://localhost:5173/", preview.agentTab)).toBe(false);
  expect(preview.check("http://localhost:5173", preview.agentTab)).toBe(false);
  expect(preview.check("http://localhost:5173", null)).toBe(false);
  expect(await preview.request("https://example.com/")).toBe(false);
  expect(await preview.request("about:srcdoc")).toBe(false);
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("shares a pending prompt and rechecks eligibility when it resolves", async () => {
  let allowLocation!: () => void;
  const answer = new Promise<boolean>((resolve) => {
    allowLocation = () => resolve(true);
  });
  const confirm = vi.fn(() => answer);
  const preview = geolocationPolicy(confirm);
  const first = preview.request("http://localhost:5173/page");
  const second = preview.request("http://localhost:5173/other");
  await Promise.resolve();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(preview.check("http://localhost:5173")).toBe(false);
  expect(await preview.request("http://localhost:5180/")).toBe(false);
  expect(await geolocationPolicy(confirm).request("http://localhost:5173/")).toBe(false);
  preview.stopDriving();
  allowLocation();
  expect(await Promise.all([first, second])).toEqual([false, false]);
  preview.startDriving();
  expect(preview.check("http://localhost:5173")).toBe(false);
});

it("denies a failed geolocation prompt and lets the next request retry", async () => {
  const confirm = vi
    .fn()
    .mockRejectedValueOnce(new Error("Dialog unavailable"))
    .mockResolvedValue(true);
  const preview = geolocationPolicy(confirm);
  expect(await preview.request("http://localhost:5173/")).toBe(false);
  expect(await preview.request("http://localhost:5173/")).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(2);
});

it("bounds the displayed origin and defaults the location dialog to Block", () => {
  const signal = new AbortController().signal;
  const origin = "http://" + "a".repeat(300) + ".localhost";
  const options = previewLocationPromptOptions(origin, signal);
  expect(options.message).toBe(origin.slice(0, 300) + "… wants to know your location");
  expect(options.buttons?.[options.defaultId!]).toBe("Block");
  expect(options.buttons?.[options.cancelId!]).toBe("Block");
  expect(options.signal).toBe(signal);
});
