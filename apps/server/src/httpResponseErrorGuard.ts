import type { Server } from "node:http";

/** A disconnected request must not become an unhandled EventEmitter error. */
export function guardHttpResponseWriteErrors(server: Server): void {
  server.on("request", (_request, response) => response.on("error", () => {}));
  server.on("upgrade", (_request, socket) => socket.on("error", () => {}));
}
