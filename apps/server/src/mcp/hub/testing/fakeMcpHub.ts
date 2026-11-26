import type { McpHubAttachInput, McpHubEndpoint, McpHubShape } from "../McpHub.ts";

/** Records attachments and issues one fixed endpoint per enabled server. */
export function makeFakeMcpHub(options: { readonly available?: boolean } = {}) {
  const attaches: McpHubAttachInput[] = [];
  let disposed = 0;
  const hub: McpHubShape = {
    available: options.available ?? true,
    attach: (input) => {
      attaches.push(input);
      const endpoints: McpHubEndpoint[] = Object.entries(input.servers ?? {})
        .filter(([name, server]) => server.enabled !== false && !input.reservedNames?.has(name))
        .map(([name, server]) => ({
          serverName: name,
          url: `http://127.0.0.1:9/mcp/user/${name}`,
          token: `token-${name}`,
          transport: server.type,
          toolTimeoutMs: 600_000,
          startupTimeoutMs: 30_000,
        }));
      return {
        endpoints,
        omitted: [],
        credentials: endpoints.map((endpoint) => endpoint.token),
        dispose: async () => {
          disposed += 1;
        },
      };
    },
    status: () => [],
    reconnect: async () => 0,
    reconnectOAuth: async () => 0,
    readStderrTail: () => undefined,
    close: async () => undefined,
  };
  return {
    hub,
    attaches,
    get disposed() {
      return disposed;
    },
  };
}
