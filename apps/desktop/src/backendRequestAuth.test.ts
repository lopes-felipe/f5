import { describe, expect, it } from "vitest";

import {
  authorizeDesktopBackendRequestHeaders,
  DESKTOP_BACKEND_REQUEST_FILTER,
  getDesktopBackendHttpOrigin,
  getDesktopBackendWebSocketUrl,
  shouldAuthorizeDesktopBackendRequest,
} from "./backendRequestAuth";

const backendPort = 3773;
const authToken = "desktop-backend-token";

function authorize(url: string, requestHeaders: Record<string, string> = {}) {
  return authorizeDesktopBackendRequestHeaders({
    url,
    backendPort,
    authToken,
    requestHeaders,
    initiator: {
      registeredRenderer: true,
      mainFrame: true,
      frameOrigin: "t3://app",
      appOrigin: "t3://app",
    },
  });
}

describe("authorizeDesktopBackendRequestHeaders", () => {
  it("derives all desktop backend endpoints from the canonical loopback origin", () => {
    expect(getDesktopBackendHttpOrigin(backendPort)).toBe(`http://127.0.0.1:${backendPort}`);
    expect(getDesktopBackendWebSocketUrl(backendPort, "token with spaces")).toBe(
      `ws://127.0.0.1:${backendPort}/?token=token+with+spaces`,
    );
    expect(DESKTOP_BACKEND_REQUEST_FILTER).toBe("http://127.0.0.1/*");
  });

  it.each([
    `http://127.0.0.1:${backendPort}/attachments/thread-1-attachment-1`,
    `http://127.0.0.1:${backendPort}/api/project-favicon?cwd=%2Frepo`,
  ])("adds bearer auth to private desktop backend requests at %s", (url) => {
    expect(authorize(url, { Accept: "image/png" })).toEqual({
      Accept: "image/png",
      Authorization: `Bearer ${authToken}`,
    });
  });

  it.each([
    `http://127.0.0.1:${backendPort + 1}/attachments/thread-1-attachment-1`,
    `http://localhost:${backendPort}/attachments/thread-1-attachment-1`,
    `https://127.0.0.1:${backendPort}/attachments/thread-1-attachment-1`,
    `http://127.0.0.1:${backendPort}/auth/status`,
    `http://127.0.0.1:${backendPort}/attachments`,
    "not a url",
  ])("does not leak bearer auth to non-backend or public requests at %s", (url) => {
    const requestHeaders = { Accept: "image/png" };
    expect(authorize(url, requestHeaders)).toBe(requestHeaders);
  });

  it("replaces stale authorization only for the exact private backend request", () => {
    expect(
      authorize(`http://127.0.0.1:${backendPort}/attachments/attachment-1`, {
        Authorization: "Bearer stale-token",
      }),
    ).toEqual({
      Authorization: `Bearer ${authToken}`,
    });
  });

  it("does not authorize requests when the desktop token is empty", () => {
    const requestHeaders = { Accept: "image/png" };
    expect(
      authorizeDesktopBackendRequestHeaders({
        url: `http://127.0.0.1:${backendPort}/attachments/attachment-1`,
        backendPort,
        authToken: "",
        requestHeaders,
      }),
    ).toBe(requestHeaders);
  });
});

describe("desktop backend initiator authorization", () => {
  const app = {
    registeredRenderer: true,
    mainFrame: true,
    frameOrigin: "t3://app",
    appOrigin: "t3://app",
  };
  it.each([
    undefined,
    { ...app, registeredRenderer: false },
    { ...app, mainFrame: false },
    { ...app, frameOrigin: "https://example.com" },
    { ...app, frameOrigin: "null", appOrigin: "null" },
  ])("refuses missing identity, guests, popups, subframes and foreign origins: %j", (initiator) => {
    expect(shouldAuthorizeDesktopBackendRequest(initiator)).toBe(false);
    const headers = { Accept: "*/*" };
    expect(
      authorizeDesktopBackendRequestHeaders({
        url: `http://127.0.0.1:${backendPort}/api/bootstrap`,
        backendPort,
        authToken,
        requestHeaders: headers,
        ...(initiator ? { initiator } : {}),
      }),
    ).toBe(headers);
  });
  it("accepts registered main frames for packaged and development origins", () => {
    expect(shouldAuthorizeDesktopBackendRequest(app)).toBe(true);
    expect(
      shouldAuthorizeDesktopBackendRequest({
        ...app,
        frameOrigin: "http://localhost:5173",
        appOrigin: "http://localhost:5173",
      }),
    ).toBe(true);
  });
});
