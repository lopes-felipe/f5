import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import {
  browserProtectionHtml,
  protectionFixtureState,
  type ProtectionFixtureState,
} from "./rehearsalProtection";

/** Local synthetic page observations only. This endpoint has no control path. */
export async function createBrowserProtectionFixture() {
  const prefix = `/${randomBytes(16).toString("hex")}`;
  const pagePath = `${prefix}/fixture`;
  const statePath = `${prefix}/state`;
  let state: ProtectionFixtureState | undefined;
  let lastObservation = 0;
  let pageRequested = false;
  let stateRejected = false;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === pagePath) {
      pageRequested = true;
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
      });
      response.end(browserProtectionHtml(statePath));
    } else if (request.method === "POST" && request.url === statePath) {
      let body = "";
      request.setEncoding("utf8");
      request.on("error", () => {});
      request.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body) > 2048) {
          stateRejected = true;
          request.destroy();
        }
      });
      request.on("end", () => {
        try {
          const next = protectionFixtureState(JSON.parse(body));
          if (!next) throw new Error("Invalid observation.");
          state = next;
          lastObservation = performance.now();
          response.writeHead(204).end();
        } catch {
          stateRejected = true;
          response.writeHead(400).end();
        }
      });
    } else {
      response.writeHead(404).end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const close = () =>
    new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  try {
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener unavailable.");
    return {
      url: `http://127.0.0.1:${address.port}${pagePath}`,
      state: () => (state ? { ...state } : undefined),
      lastObservationAt: () => lastObservation,
      observation: () => ({ pageRequested, stateReported: !!state, stateRejected }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
