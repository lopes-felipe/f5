// @effect-diagnostics nodeBuiltinImport:off - real child fetch, TLS and proxy negotiation.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as Http from "node:http";
import * as Http2 from "node:http2";
import * as Net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { builtinFetchUsesHttp2 } from "./outboundHttp.ts";
import { LOCALHOST_TEST_CERT, LOCALHOST_TEST_KEY } from "./testUtils/localhostTls.ts";

const run = promisify(execFile);
const sockets = new Set<Net.Socket>();
const sessions = new Set<Http2.ServerHttp2Session>();
const origin = Http2.createSecureServer(
  { allowHTTP1: true, key: LOCALHOST_TEST_KEY, cert: LOCALHOST_TEST_CERT },
  (request, response) => response.end(request.httpVersion),
);
const proxy = Http.createServer();
let targetUrl: string;
let proxyUrl: string;
let certificateFile: string;
let directory: string;
let proxyConnects = 0;
let proxyAuthorization: string | undefined;
const trackSocket = (socket: Net.Socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
};
origin.on("connection", trackSocket);
origin.on("session", (session) => {
  sessions.add(session);
  session.on("close", () => sessions.delete(session));
});
proxy.on("connection", trackSocket);
proxy.on("connect", (request, client, head) => {
  if (request.url !== new URL(targetUrl).host) {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  proxyConnects++;
  proxyAuthorization = request.headers["proxy-authorization"];
  const upstream = Net.connect(Number(new URL(targetUrl).port), "127.0.0.1");
  trackSocket(upstream);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.on("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
});

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "f5-outbound-http-"));
  certificateFile = path.join(directory, "public-test-ca.pem");
  await writeFile(certificateFile, LOCALHOST_TEST_CERT);
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  targetUrl = `https://127.0.0.1:${(origin.address() as Net.AddressInfo).port}`;
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://fixture:proxy@127.0.0.1:${(proxy.address() as Net.AddressInfo).port}`;
});
afterAll(async () => {
  for (const session of sessions) session.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise<void>((resolve) => origin.close(() => resolve())),
    new Promise<void>((resolve) => proxy.close(() => resolve())),
  ]);
  await rm(directory, { recursive: true, force: true });
});

it.each([
  [undefined, false],
  ["", false],
  ["7.24.0", false],
  ["8.0.0", true],
  ["8.11.2", true],
  ["9.0.0", true],
  ["invalid", false],
] as const)("gates the bundled fetch version %s", (version, expected) => {
  expect(builtinFetchUsesHttp2(version)).toBe(expected);
});

const script = `
  import { pathToFileURL } from 'node:url';
  const [mode, policyFile, origin] = process.argv.slice(1);
  let sameDispatcher = true;
  if (mode !== 'baseline') {
    const policy = await import(pathToFileURL(policyFile).href);
    policy.keepOutboundFetchOnHttp1();
    const first = globalThis[Symbol.for('undici.globalDispatcher.2')];
    policy.keepOutboundFetchOnHttp1();
    sameDispatcher = first === globalThis[Symbol.for('undici.globalDispatcher.2')];
  }
  const response = await fetch(origin, { signal: AbortSignal.timeout(5000) });
  const protocol = await response.text();
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.2')];
  console.log(JSON.stringify({ protocol, sameDispatcher, dispatcher: dispatcher?.constructor.name }));
  await dispatcher?.close();
`;
async function protocol(mode: "baseline" | "policy" | "proxy") {
  const { stdout } = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      mode,
      fileURLToPath(new URL("./outboundHttp.ts", import.meta.url)),
      targetUrl,
    ],
    {
      env: {
        PATH: process.env.PATH,
        NODE_EXTRA_CA_CERTS: certificateFile,
        ...(mode === "proxy"
          ? { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxyUrl, NO_PROXY: "" }
          : {}),
      },
      timeout: 10_000,
      maxBuffer: 32_768,
    },
  );
  return JSON.parse(stdout) as { protocol: string; sameDispatcher: boolean; dispatcher: string };
}

it.runIf(builtinFetchUsesHttp2(process.versions.undici))(
  "moves real built-in fetch off HTTP/2 and initializes only once",
  async () => {
    expect((await protocol("baseline")).protocol).toBe("2.0");
    expect(await protocol("policy")).toMatchObject({
      protocol: "1.1",
      sameDispatcher: true,
      dispatcher: "Agent",
    });
  },
  20_000,
);
it.runIf(builtinFetchUsesHttp2(process.versions.undici))(
  "retains the actual environment proxy and its credentials",
  async () => {
    const before = proxyConnects;
    expect(await protocol("proxy")).toMatchObject({
      protocol: "1.1",
      sameDispatcher: true,
      dispatcher: "EnvHttpProxyAgent",
    });
    expect(proxyConnects).toBeGreaterThan(before);
    expect(proxyAuthorization).toBe(`Basic ${Buffer.from("fixture:proxy").toString("base64")}`);
  },
  20_000,
);
