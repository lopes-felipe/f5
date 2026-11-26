import { describe, expect, it } from "vitest";

import { MCP_CATALOG_CACHE_MS, makeMcpCatalog, toCatalogEntry } from "./McpCatalog.ts";

// Shaped like a real registry page (v0.1, schema 2025-12-11).
const page = {
  servers: [
    {
      server: {
        name: "io.github.acme/notes",
        title: "Notes",
        description: "Notes for agents",
        version: "1.2.0",
        repository: { url: "https://github.com/acme/notes", source: "github" },
        remotes: [
          {
            type: "streamable-http",
            url: "https://notes.example/mcp",
            headers: [{ name: "Authorization", isRequired: true, isSecret: true }],
          },
          { type: "websocket", url: "wss://notes.example" },
        ],
        packages: [
          {
            registryType: "npm",
            identifier: "@acme/notes",
            version: "1.2.0",
            transport: { type: "stdio" },
            environmentVariables: [{ name: "NOTES_TOKEN", isRequired: true, isSecret: true }],
            packageArguments: [
              { type: "named", name: "--read-only", format: "boolean" },
              { type: "positional", valueHint: "root", isRequired: true },
            ],
          },
          {
            registryType: "npm",
            identifier: "@acme/notes",
            transport: { type: "sse", url: "http://127.0.0.1:{port}/sse" },
          },
          { registryType: "nuget", identifier: "Acme.Notes", transport: { type: "stdio" } },
        ],
      },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
    },
    {
      server: { name: "io.github.acme/gone", remotes: [{ type: "sse", url: "https://x/sse" }] },
      _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } },
    },
    { server: { name: "io.github.acme/unrunnable", packages: [{ registryType: "mcpb" }] } },
  ],
  metadata: { nextCursor: "io.github.acme/notes:1.2.0", count: 3 },
};

function fakeFetch(body: unknown, status = 200) {
  const urls: URL[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
}

describe("MCP catalog", () => {
  it("keeps what F5 can run: HTTP and SSE remotes, and stdio npm, PyPI and image packages", () => {
    expect(toCatalogEntry(page.servers[0])).toEqual({
      name: "io.github.acme/notes",
      title: "Notes",
      description: "Notes for agents",
      version: "1.2.0",
      repositoryUrl: "https://github.com/acme/notes",
      remotes: [
        {
          type: "http",
          url: "https://notes.example/mcp",
          headers: [{ name: "Authorization", required: true, secret: true }],
        },
      ],
      packages: [
        {
          registryType: "npm",
          identifier: "@acme/notes",
          version: "1.2.0",
          environmentVariables: [{ name: "NOTES_TOKEN", required: true, secret: true }],
          packageArguments: [
            { type: "named", name: "--read-only", required: false, flag: true },
            { type: "positional", valueHint: "root", required: true, flag: false },
          ],
          runtimeArguments: [],
        },
      ],
    });
    expect(toCatalogEntry(page.servers[1])).toBeUndefined();
    expect(toCatalogEntry(page.servers[2])).toBeUndefined();
  });

  it("searches the registry's latest versions and caches each page for an hour", async () => {
    const { fetch, urls } = fakeFetch(page);
    let now = 1_000;
    const catalog = makeMcpCatalog({ fetch, now: () => now });

    const first = await catalog.search({ query: " notes " });
    expect(first.entries.map((item) => item.name)).toEqual(["io.github.acme/notes"]);
    expect(first.nextCursor).toBe("io.github.acme/notes:1.2.0");
    expect(urls[0]?.origin + urls[0]!.pathname).toBe(
      "https://registry.modelcontextprotocol.io/v0.1/servers",
    );
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      limit: "30",
      version: "latest",
      search: "notes",
    });

    await catalog.search({ query: "notes" });
    expect(urls).toHaveLength(1);
    await catalog.search({ query: "notes", cursor: first.nextCursor });
    expect(urls[1]?.searchParams.get("cursor")).toBe("io.github.acme/notes:1.2.0");

    now += MCP_CATALOG_CACHE_MS;
    await catalog.search({ query: "notes" });
    expect(urls).toHaveLength(3);
  });

  it("explains a failed registry call", async () => {
    const catalog = makeMcpCatalog({ fetch: fakeFetch({}, 503).fetch });
    await expect(catalog.search({})).rejects.toThrow(/answered 503/);
  });
});
