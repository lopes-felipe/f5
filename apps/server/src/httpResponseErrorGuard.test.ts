import { createServer, ServerResponse, IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { expect, it } from "vitest";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";

it("observes late response and upgrade write errors without an uncaught exception", () => {
  const server = createServer();
  const reported: string[] = [];
  guardHttpResponseWriteErrors(server, (code) => reported.push(code));
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  const response = new ServerResponse(request);
  server.emit("request", request, response);
  server.emit("upgrade", request, socket, Buffer.alloc(0));
  for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]) {
    const error = Object.assign(new Error("disconnected"), { code });
    expect(() => response.emit("error", error)).not.toThrow();
    expect(() => socket.emit("error", error)).not.toThrow();
  }
  expect(reported).toEqual([]);
  response.emit("error", Object.assign(new Error("sensitive request data"), { code: "EIO" }));
  socket.emit("error", Object.assign(new Error("secret"), { code: "token=secret" }));
  expect(reported).toEqual(["EIO", "UNKNOWN"]);
  socket.destroy();
});
