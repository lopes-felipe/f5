import { describe, expect, it } from "vitest";
import { MCP_APP_MAX_HTML_BYTES, MCP_APP_MIME_TYPE } from "@t3tools/shared/mcpApp";
import { readMcpAppDocument } from "./McpAppSnapshot.ts";
const uri = "ui://weather/dashboard";
const resource = (patch: Record<string, unknown> = {}) => ({
  contents: [{ uri, mimeType: MCP_APP_MIME_TYPE, text: "<p>Weather</p>", ...patch }],
});
describe("MCP app resource selection", () => {
  it("reads only the requested app document and its declared policy", () => {
    expect(
      readMcpAppDocument(
        resource({
          _meta: {
            ui: {
              csp: { connectDomains: ["https://weather.example", "'unsafe-eval'"] },
              permissions: { camera: {} },
              prefersBorder: false,
            },
          },
        }),
        uri,
      ),
    ).toMatchObject({
      html: "<p>Weather</p>",
      csp: { connectDomains: ["https://weather.example"] },
      permissions: { camera: {} },
      prefersBorder: false,
    });
    expect(readMcpAppDocument(resource(), "ui://bank/transfer")).toBeUndefined();
    expect(readMcpAppDocument(resource({ mimeType: "text/html" }), uri)).toBeUndefined();
  });
  it("reads strict base64 UTF-8 and rejects malformed resources", () => {
    expect(
      readMcpAppDocument(
        resource({ text: undefined, blob: Buffer.from("<p>☀</p>").toString("base64") }),
        uri,
      )?.html,
    ).toBe("<p>☀</p>");
    for (const blob of ["%%%", "//8=", "a"])
      expect(readMcpAppDocument(resource({ text: undefined, blob }), uri)).toBeUndefined();
    expect(readMcpAppDocument(resource({ text: "   " }), uri)).toBeUndefined();
  });
  it("enforces the UTF-8 byte limit and bounds the resource count", () => {
    expect(
      readMcpAppDocument(resource({ text: "x".repeat(MCP_APP_MAX_HTML_BYTES + 1) }), uri),
    ).toBeUndefined();
    expect(
      readMcpAppDocument(
        resource({ text: "界".repeat(Math.ceil(MCP_APP_MAX_HTML_BYTES / 3)) }),
        uri,
      ),
    ).toBeUndefined();
    expect(
      readMcpAppDocument(
        { contents: Array.from({ length: 101 }, () => resource().contents[0]) },
        uri,
      ),
    ).toBeUndefined();
  });
});
