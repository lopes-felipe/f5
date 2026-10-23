import { expect, it, vi } from "vitest";

import { installPreviewPermissionPolicy } from "./previewPermissions";

it("lets preview pages copy and go fullscreen, and denies everything else", () => {
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
  expect(granted("clipboard-sanitized-write")).toBe(true);
  expect(granted("fullscreen")).toBe(true);
  for (const permission of [
    "openExternal",
    "clipboard-read",
    "notifications",
    "geolocation",
    "media",
    "local-fonts",
  ]) {
    expect(granted(permission)).toBe(false);
  }
  expect(check!({}, "clipboard-sanitized-write")).toBe(true);
  expect(check!({}, "media")).toBe(false);
});

it("lets the user's own local app use its camera, location and file pickers", () => {
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
  expect(check!(userTab, "geolocation", "http://localhost:5173")).toBe(true);
  // A page the agent drives, a remote origin and an unlisted permission stay denied.
  expect(granted(agentTab, "media", "http://localhost:5173/")).toBe(false);
  expect(granted(userTab, "media", "https://example.com/")).toBe(false);
  expect(granted(userTab, "openExternal", "http://localhost:5173/")).toBe(false);
  expect(check!(null, "media", "http://localhost:5173")).toBe(false);
});
