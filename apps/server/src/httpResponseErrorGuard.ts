import type { Server } from "node:http";

const EXPECTED_DISCONNECT_CODES = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]);

/** Observe disconnects; report unexpected failures without logging request data or error messages. */
export function guardHttpResponseWriteErrors(
  server: Server,
  reportUnexpected: (code: string) => void = () => {},
): void {
  const onError = (error: Error & { code?: string }) => {
    const code =
      typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : "UNKNOWN";
    if (!EXPECTED_DISCONNECT_CODES.has(code)) reportUnexpected(code);
  };
  server.on("request", (_request, response) => response.on("error", onError));
  server.on("upgrade", (_request, socket) => socket.on("error", onError));
}
