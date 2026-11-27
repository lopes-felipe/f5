import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import { mcpServerIdentity } from "./hub/McpHubGovernance.ts";
import { resolveMcpSecrets } from "./McpSecretResolver.ts";
import { maskResolvedMcpSecrets, resolvedMcpSecretsIn } from "./mcpResolvedSecrets.ts";

const ids = {
  path: "00000000-0000-4000-8000-0000000000a1",
  short: "00000000-0000-4000-8000-0000000000a2",
};

function storeWith(values: Record<string, string>): ServerSecretStoreShape {
  return {
    get: (name: string) => {
      const value = values[name.replace(/^mcp-secret-/, "")];
      return Effect.succeed(value === undefined ? null : new TextEncoder().encode(value));
    },
  } as unknown as ServerSecretStoreShape;
}

describe("resolved MCP secrets", () => {
  it("encodes secrets in URLs and keeps them out of the pin identity", async () => {
    const reference = "${f5-secret:" + ids.path + "}";
    const server = { type: "http" as const, url: `https://mcp.example/k/${reference}/sse` };
    const first = await Effect.runPromise(
      resolveMcpSecrets({ remote: server }, storeWith({ [ids.path]: "path/key?x#y@z" })),
    );
    // `/ ? # @` in the value cannot change the URL's parts.
    const url = first.servers.remote!.url!;
    expect(new URL(url).pathname).toBe(`/k/${encodeURIComponent("path/key?x#y@z")}/sse`);
    const identity = mcpServerIdentity("remote", first.servers.remote!);
    expect(identity.label).toBe("https://mcp.example/k/$%7Bf5-secret%7D/sse");
    expect(identity.label).not.toContain("path");

    // A rotated secret keeps the same identity, so pins are not reset and trusted anew.
    const rotated = await Effect.runPromise(
      resolveMcpSecrets({ remote: server }, storeWith({ [ids.path]: "another-secret-value" })),
    );
    expect(mcpServerIdentity("remote", rotated.servers.remote!).key).toBe(identity.key);
  });

  it("redacts a composite field even when the secret itself is short", async () => {
    const reference = "${f5-secret:" + ids.short + "}";
    const resolved = await Effect.runPromise(
      resolveMcpSecrets(
        { cli: { type: "stdio", command: "node", args: [`--api-token=${reference}`] } },
        storeWith({ [ids.short]: "abc" }),
      ),
    );
    expect(resolved.servers.cli?.args).toEqual(["--api-token=abc"]);
    // The short value alone would mangle diagnostics; the whole argument is redacted.
    expect(resolvedMcpSecretsIn("server echoed --api-token=abc on stderr")).toEqual([
      "--api-token=abc",
    ]);
    expect(resolvedMcpSecretsIn("abc")).toEqual([]);
    expect(maskResolvedMcpSecrets("token abc")).toBe("token ${f5-secret}");
  });
});
