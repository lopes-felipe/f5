import type { McpProjectServersConfig } from "@t3tools/contracts";

import type { McpHubAttachInput, McpHubEndpoint, McpHubOmission, McpHubShape } from "../McpHub.ts";

/** Records attachments and issues one fixed endpoint per enabled server. */
export function makeFakeMcpHub(
  options: {
    readonly available?: boolean;
    /** Servers every attach and update reports as left out. */
    readonly omitted?: ReadonlyArray<McpHubOmission>;
    /** Servers every update reports as needing a longer provider timeout. */
    readonly timeoutRaised?: ReadonlyArray<string>;
  } = {},
) {
  const attaches: McpHubAttachInput[] = [];
  const updates: Array<McpProjectServersConfig | null | undefined> = [];
  const declined: string[] = [];
  let disposed = 0;
  const hub: McpHubShape = {
    available: options.available ?? true,
    attach: (input) => {
      attaches.push(input);
      const endpointFor = (
        name: string,
        server: McpProjectServersConfig[string],
      ): McpHubEndpoint => ({
        serverName: name,
        url: `http://127.0.0.1:9/mcp/user/${name}`,
        token: `token-${name}`,
        transport: server.type,
        toolTimeoutMs: 600_000,
        startupTimeoutMs: 30_000,
      });
      const endpoints: McpHubEndpoint[] = Object.entries(input.servers ?? {})
        .filter(([name, server]) => server.enabled !== false && !input.reservedNames?.has(name))
        .map(([name, server]) => endpointFor(name, server));
      return {
        endpoints,
        omitted: options.omitted ?? [],
        get credentials() {
          return endpoints.map((endpoint) => endpoint.token);
        },
        update: (servers, updateOptions) => {
          updates.push(servers);
          const names = new Set(endpoints.map((endpoint) => endpoint.serverName));
          const next = Object.entries(servers ?? {}).filter(
            ([name, server]) => server.enabled !== false && !input.reservedNames?.has(name),
          );
          const addedEntries = next.filter(([name]) => !names.has(name));
          const addedEndpoints = updateOptions?.addEndpoints
            ? addedEntries.map(([name, server]) => endpointFor(name, server))
            : [];
          endpoints.push(...addedEndpoints);
          return {
            changed: next.flatMap(([name]) => (names.has(name) ? [name] : [])),
            removed: [...names].filter((name) => !next.some(([other]) => other === name)),
            added: addedEntries.map(([name]) => name),
            addedEndpoints,
            endpoints: endpoints.filter((endpoint) =>
              next.some(([name]) => name === endpoint.serverName),
            ),
            omitted: options.omitted ?? [],
            timeoutRaised: options.timeoutRaised ?? [],
          };
        },
        decline: (names) => {
          declined.push(...names);
        },
        dispose: async () => {
          disposed += 1;
        },
      };
    },
    status: () => [],
    reconnect: async () => 0,
    reconnectOAuth: async () => 0,
    accountEnvironment: () => undefined,
    readStderrTail: () => undefined,
    close: async () => undefined,
  };
  return {
    hub,
    attaches,
    updates,
    declined,
    get disposed() {
      return disposed;
    },
  };
}
