// Adapted from upstream da7c4f234db35096af2c16d5e24c60dbe9495583.
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vitest";

import {
  findMcpAppToolPolicy,
  injectMcpAppCsp,
  injectMcpAppThemeBootstrap,
  injectMcpAppCookieBootstrap,
  mcpAppAllowAttribute,
  mcpAppContentSecurityPolicy,
  mcpAppToolCallableByApp,
  readMcpAppCsp,
  readMcpAppReference,
  readMcpAppResourceUri,
} from "./mcpApp";

describe("mcpAppContentSecurityPolicy", () => {
  it("blocks the network and T3's own origin when the app declares nothing", () => {
    const policy = mcpAppContentSecurityPolicy(undefined);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).not.toContain("'self'");
  });

  it("allows exactly the declared origins", () => {
    const policy = mcpAppContentSecurityPolicy({
      connectDomains: ["https://api.weather.test"],
      resourceDomains: ["https://*.cdn.test"],
    });
    expect(policy).toContain("connect-src https://api.weather.test");
    expect(policy).toContain("script-src 'unsafe-inline' https://*.cdn.test");
    expect(policy).toContain("img-src data: blob: https://*.cdn.test");
  });
});

describe("injectMcpAppCsp", () => {
  it("puts the policy after the doctype and ahead of every script", () => {
    const html = "<!DOCTYPE html><html><head><script>x()</script></head></html>";
    const injected = injectMcpAppCsp(html, undefined);
    expect(injected.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(
      true,
    );
    expect(injected.indexOf("connect-src 'none'")).toBeLessThan(injected.indexOf("<script>"));
    expect(injectMcpAppCsp("<p>hi</p>", undefined).startsWith("<!doctype html><meta")).toBe(true);
  });
});

describe("injectMcpAppThemeBootstrap", () => {
  it("keeps stored CSP before the bootstrap and vendor scripts after it", () => {
    const snapshot = injectMcpAppCsp(
      "<html><head><script>vendor()</script></head></html>",
      undefined,
    );
    const html = injectMcpAppThemeBootstrap(snapshot);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"));
    expect(html.indexOf("window.addEventListener")).toBeLessThan(html.indexOf("vendor()"));
    expect(html.endsWith(snapshot.slice(snapshot.indexOf("<html>")))).toBe(true);
  });

  it("applies parent initialize and theme changes while ignoring unrelated or invalid messages", () => {
    const html = injectMcpAppThemeBootstrap(injectMcpAppCsp("<p>app</p>", undefined));
    const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"));
    const parent = {};
    const style = { colorScheme: "normal" };
    let receive: ((event: { source: object; data: unknown }) => void) | undefined;
    NodeVM.runInNewContext(script, {
      window: {
        parent,
        addEventListener: (_type: string, callback: typeof receive) => {
          receive = callback;
        },
      },
      document: { documentElement: { style } },
    });
    const send = (data: unknown, source = parent) => receive?.({ source, data });
    const initialized = { jsonrpc: "2.0", id: 1, result: { hostContext: { theme: "dark" } } };
    send(initialized, {});
    expect(style.colorScheme).toBe("normal");
    send(initialized);
    expect(style.colorScheme).toBe("dark");
    for (const data of [
      null,
      "bad",
      {},
      { ...initialized, jsonrpc: "1.0" },
      { jsonrpc: "2.0", method: "other", params: { theme: "light" } },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "normal" },
      },
      { jsonrpc: "2.0", result: { hostContext: { theme: "light" } } },
    ])
      send(data);
    expect(style.colorScheme).toBe("dark");
    send({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    });
    expect(style.colorScheme).toBe("light");
    send(initialized);
    expect(style.colorScheme).toBe("dark");
  });
});

describe("readMcpAppCsp", () => {
  it("drops entries that could widen or break the policy", () => {
    expect(
      readMcpAppCsp({
        connectDomains: [
          "https://ok.test",
          "*",
          "'self'",
          "https://evil.test; script-src *",
          "http://localhost:3000",
          "javascript:alert(1)",
        ],
        resourceDomains: "https://not-an-array.test",
      }),
    ).toEqual({ connectDomains: ["https://ok.test", "http://localhost:3000"] });
    expect(readMcpAppCsp({ connectDomains: ["*"] })).toBeUndefined();
  });
});

describe("readMcpAppReference", () => {
  it("requires a ui:// resource and the owning server and tool", () => {
    const reference = {
      attachmentId: "thread-1-abc-html",
      server: "weather",
      tool: "get_weather",
      resourceUri: "ui://weather/dashboard",
    };
    expect(readMcpAppReference(reference)).toEqual(reference);
    expect(readMcpAppReference({ ...reference, resourceUri: "https://x.test" })).toBeUndefined();
    expect(readMcpAppReference({ ...reference, server: "" })).toBeUndefined();
  });
});

describe("tool metadata", () => {
  it("reads the resource URI from either spelling and honors app visibility", () => {
    expect(readMcpAppResourceUri({ ui: { resourceUri: "ui://a/b" } })).toBe("ui://a/b");
    expect(readMcpAppResourceUri({ "ui/resourceUri": "ui://a/c" })).toBe("ui://a/c");
    expect(readMcpAppResourceUri({ ui: { resourceUri: "https://a" } })).toBeUndefined();
    expect(mcpAppToolCallableByApp(undefined)).toBe(true);
    expect(mcpAppToolCallableByApp({ ui: { visibility: ["model"] } })).toBe(false);
    expect(mcpAppToolCallableByApp({ ui: { visibility: ["model", "app"] } })).toBe(true);
  });
});

describe("app tool ownership", () => {
  it("accepts only a reference belonging to the producing server and tool", async () => {
    const { readMcpAppReferenceForTool } = await import("./mcpApp");
    const value = {
      attachmentId: "thread-app",
      server: "weather",
      tool: "forecast",
      resourceUri: "ui://weather/dashboard",
    };
    expect(readMcpAppReferenceForTool(value, "weather", "forecast")).toEqual(value);
    expect(readMcpAppReferenceForTool(value, "bank", "forecast")).toBeUndefined();
    expect(readMcpAppReferenceForTool(value, "weather", "transfer")).toBeUndefined();
  });
  it("preserves a bounded resource URI longer than a name", () => {
    const value = {
      attachmentId: "thread-app",
      server: "weather",
      tool: "forecast",
      resourceUri: `ui://weather/${"segment/".repeat(60)}dashboard`,
    };
    expect(readMcpAppReference(value)?.resourceUri).toBe(value.resourceUri);
    expect(
      readMcpAppReference({ ...value, resourceUri: "ui://" + "x".repeat(4096) }),
    ).toBeUndefined();
  });
});

describe("MCP App cookie bootstrap", () => {
  const vendor = `<script>document.cookie.split(";");document.cookie="analytics=1";document.root="rendered";</script>`;
  const execute = (html: string, document: object) => {
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      NodeVM.runInNewContext(script[1]!, { document });
    }
  };

  it("lets cookie-reading startup code render in an opaque document without granting storage", () => {
    const blocked = new DOMException("Opaque origin", "SecurityError");
    const prototype = Object.defineProperty({}, "cookie", {
      get() {
        throw blocked;
      },
      set() {
        throw blocked;
      },
    });
    const document = Object.assign(
      Object.create(prototype) as { cookie: string; root: string; indexedDB: unknown },
      { root: "" },
    );
    Object.defineProperty(document, "indexedDB", {
      get() {
        throw blocked;
      },
    });
    const saved = injectMcpAppCsp(vendor, { connectDomains: ["https://analytics.example"] });
    const html = injectMcpAppCookieBootstrap(saved);
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"));
    expect(html).toContain("connect-src https://analytics.example");
    execute(html, document);
    expect(document.root).toBe("rendered");
    expect(document.cookie).toBe("");
    document.cookie = "session=secret";
    expect(document.cookie).toBe("");
    expect(() => document.indexedDB).toThrow(blocked);
    expect(() => Reflect.get(prototype, "cookie")).toThrow(blocked);
  });

  it("leaves functioning cookie reads and writes unchanged", () => {
    const document = { cookie: "existing=1", root: "" };
    execute(injectMcpAppCookieBootstrap(vendor), document);
    expect(document).toEqual({ cookie: "analytics=1", root: "rendered" });
  });

  it("leaves other cookie failures unchanged", () => {
    const failure = new TypeError("Unexpected cookie failure");
    const document = Object.defineProperty({}, "cookie", {
      get() {
        throw failure;
      },
    });
    expect(() => execute(injectMcpAppCookieBootstrap(vendor), document)).toThrow(failure);
    expect(() => Reflect.get(document, "cookie")).toThrow(failure);
  });
});

describe("findMcpAppToolPolicy", () => {
  it("requires an unambiguous app-visible tool and explicit read-only annotation", () => {
    const tool = { name: "forecast", annotations: { readOnlyHint: true } };
    expect(findMcpAppToolPolicy([tool], "forecast")?.readOnlyHint).toBe(true);
    expect(findMcpAppToolPolicy([{ name: "forecast" }], "forecast")?.readOnlyHint).toBe(false);
    expect(findMcpAppToolPolicy([tool, tool], "forecast")).toBeUndefined();
    expect(
      findMcpAppToolPolicy([{ ...tool, _meta: { ui: { visibility: ["model"] } } }], "forecast"),
    ).toBeUndefined();
    expect(
      findMcpAppToolPolicy([{ ...tool, annotations: { readOnlyHint: "true" } }], "forecast")
        ?.readOnlyHint,
    ).toBe(false);
    expect(findMcpAppToolPolicy(Array(2001).fill(tool), "forecast")).toBeUndefined();
  });
});

describe("mcpAppAllowAttribute", () => {
  it("delegates clipboard writes but never camera, microphone or location", () => {
    expect(
      mcpAppAllowAttribute({ camera: {}, microphone: {}, geolocation: {}, clipboardWrite: {} }),
    ).toBe("clipboard-write");
    expect(mcpAppAllowAttribute({ microphone: {} })).toBe("");
    expect(mcpAppAllowAttribute(undefined)).toBe("");
  });
});
