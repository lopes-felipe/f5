import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  resolveServerPerMessageDeflate,
  WEB_SOCKET_PER_MESSAGE_DEFLATE,
  webSocketRuntimeName,
} from "./webSocketTransport";

const servers: WebSocketServer[] = [];
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.terminate();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function connect(input: { readonly compression: boolean }) {
  const server = new WebSocketServer({
    port: 0,
    perMessageDeflate: WEB_SOCKET_PER_MESSAGE_DEFLATE,
  });
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected WebSocket server to listen on a TCP port");
  }

  const client = new WebSocket(`ws://127.0.0.1:${address.port}`, {
    perMessageDeflate: input.compression,
  });
  clients.push(client);
  const serverConnection = once(server, "connection") as Promise<[WebSocket]>;
  const clientOpen = once(client, "open");
  const [[serverSocket]] = await Promise.all([serverConnection, clientOpen]);
  return { client, serverSocket };
}

describe("webSocketTransport", () => {
  it("enables bounded compression on Node and explicitly disables it on Bun", () => {
    expect(resolveServerPerMessageDeflate({ node: "24.0.0" })).toEqual(
      WEB_SOCKET_PER_MESSAGE_DEFLATE,
    );
    expect(resolveServerPerMessageDeflate({ node: "24.0.0", bun: "1.3.0" })).toBe(false);
    expect(webSocketRuntimeName({ node: "24.0.0" })).toBe("node");
    expect(webSocketRuntimeName({ node: "24.0.0", bun: "1.3.0" })).toBe("bun");
  });

  it("negotiates compression and preserves a payload above the threshold", async () => {
    const { client, serverSocket } = await connect({ compression: true });
    const payload = "compressible-payload".repeat(4_096);
    const received = once(client, "message");

    serverSocket.send(payload);

    const [data] = await received;
    expect(data.toString()).toBe(payload);
    expect(client.extensions).toContain("permessage-deflate");
    expect(serverSocket.extensions).toContain("permessage-deflate");
  });

  it("serves the same payload when the client declines compression", async () => {
    const { client, serverSocket } = await connect({ compression: false });
    const payload = "uncompressed-payload".repeat(4_096);
    const received = once(client, "message");

    serverSocket.send(payload);

    const [data] = await received;
    expect(data.toString()).toBe(payload);
    expect(client.extensions).toBe("");
    expect(serverSocket.extensions).toBe("");
  });
});
