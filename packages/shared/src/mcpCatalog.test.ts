import type { McpCatalogEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { mcpCatalogDraft, mcpCatalogOptions, mcpCatalogServerName } from "./mcpCatalog";

const entry = (overrides: Partial<McpCatalogEntry>): McpCatalogEntry => ({
  name: "io.github.acme/mcp-server-notes",
  description: "Notes for agents",
  remotes: [],
  packages: [],
  ...overrides,
});

describe("MCP catalog drafts", () => {
  it("names servers from the registry name and lists remotes first", () => {
    const notes = entry({
      remotes: [{ type: "http", url: "https://notes.example/mcp", headers: [] }],
      packages: [
        {
          registryType: "npm",
          identifier: "@acme/notes",
          environmentVariables: [],
          packageArguments: [],
          runtimeArguments: [],
        },
      ],
    });
    expect(mcpCatalogServerName(notes)).toBe("notes");
    expect(mcpCatalogOptions(notes).map((option) => option.label)).toEqual([
      "Remote (HTTP)",
      "npm package",
    ]);
  });

  it("maps a remote, leaving secret headers for a stored secret", () => {
    const draft = mcpCatalogDraft(
      entry({
        remotes: [
          {
            type: "sse",
            url: "https://notes.example/{tenant}/sse",
            headers: [
              { name: "Authorization", required: true, secret: true, value: "Bearer {key}" },
              { name: "X-Region", required: false, secret: false, default: "eu" },
              { name: "X-Optional-Token", required: false, secret: true },
            ],
          },
        ],
      }),
      { kind: "remote", index: 0 },
    );
    expect(draft).toEqual({
      name: "notes",
      server: {
        type: "sse",
        url: "https://notes.example/{tenant}/sse",
        headers: { Authorization: "", "X-Region": "eu" },
        description: "Notes for agents",
      },
      secretKeys: ["Authorization"],
      needsInput: ["the URL's {placeholders}"],
    });
  });

  it("runs npm packages with npx -y at their version, with declared arguments", () => {
    const draft = mcpCatalogDraft(
      entry({
        packages: [
          {
            registryType: "npm",
            identifier: "@acme/notes",
            version: "1.2.0",
            runtimeArguments: [{ type: "positional", value: "-y", required: false, flag: false }],
            packageArguments: [
              {
                type: "named",
                name: "allowed-directories",
                required: true,
                flag: false,
              },
              { type: "named", name: "--read-only", required: false, flag: true },
              { type: "positional", valueHint: "root", required: true, flag: false },
            ],
            environmentVariables: [
              { name: "NOTES_TOKEN", required: true, secret: true },
              { name: "NOTES_URL", required: true, secret: false },
              { name: "NOTES_MODE", required: false, secret: false, default: "fast" },
              { name: "NOTES_DEBUG", required: false, secret: false },
            ],
          },
        ],
      }),
      { kind: "package", index: 0 },
    );
    expect(draft.server).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@acme/notes@1.2.0", "--allowed-directories", "<allowed-directories>", "<root>"],
      env: { NOTES_TOKEN: "", NOTES_URL: "", NOTES_MODE: "fast" },
      description: "Notes for agents",
    });
    expect(draft.secretKeys).toEqual(["NOTES_TOKEN"]);
    expect(draft.needsInput).toEqual([
      "NOTES_URL",
      "--allowed-directories <allowed-directories>",
      "argument <root>",
    ]);
  });

  it("runs PyPI packages with uvx and images with docker run, passing variables in", () => {
    const python = mcpCatalogDraft(
      entry({
        packages: [
          {
            registryType: "pypi",
            identifier: "notes-mcp",
            version: "0.3.1",
            environmentVariables: [],
            packageArguments: [],
            runtimeArguments: [],
          },
        ],
      }),
      { kind: "package", index: 0 },
    );
    expect(python.server).toMatchObject({ command: "uvx", args: ["notes-mcp==0.3.1"] });

    const image = mcpCatalogDraft(
      entry({
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/acme/notes:1.0",
            environmentVariables: [{ name: "NOTES_TOKEN", required: true, secret: true }],
            packageArguments: [],
            runtimeArguments: [
              { type: "named", name: "-i", required: true, flag: true },
              { type: "named", name: "--rm", required: true, flag: true },
            ],
          },
        ],
      }),
      { kind: "package", index: 0 },
    );
    expect(image.server).toMatchObject({
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "NOTES_TOKEN", "ghcr.io/acme/notes:1.0"],
      env: { NOTES_TOKEN: "" },
    });
  });
});
