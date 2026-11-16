import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { expect, it } from "vitest";
import {
  observeComputerMcpRequest,
  type RehearsalMcpTransportReceipt,
} from "./rehearsalMcpTransport";

async function exchange(
  status: number,
  body: unknown,
  input = JSON.stringify({ method: "tools/call", params: { text: "PRIVATE_UNICODE_💙" } }),
  path = "/mcp/computer",
  throws = false,
) {
  const receipts: RehearsalMcpTransportReceipt[] = [];
  let writeCallback = false;
  let endCallback = false;
  let received = "";
  const encoded = JSON.stringify(body);
  const server = http.createServer((request, response) => {
    request.on("data", (data) => {
      received += data.toString();
    });
    request.once("end", () => {
      response.writeHead(status, {
        "content-type": "application/json",
        "x-fixture": "PRIVATE_HEADER",
      });
      const bytes = Buffer.from(encoded);
      response.write(bytes.subarray(0, 7), () => {
        writeCallback = true;
      });
      response.end(bytes.subarray(7), () => {
        endCallback = true;
      });
    });
  });
  server.prependListener("request", (request, response) =>
    observeComputerMcpRequest(request, response, (receipt) => {
      receipts.push(receipt);
      if (throws) throw new Error("PRIVATE_DIAGNOSTIC_ERROR");
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
      {
        method: "POST",
        headers: { authorization: "Bearer PRIVATE_TOKEN", "mcp-session-id": "PRIVATE_SESSION" },
        body: input,
      },
    );
    const actual = await response.text();
    expect(response.status).toBe(status);
    expect(response.headers.get("x-fixture")).toBe("PRIVATE_HEADER");
    expect(actual).toBe(encoded);
    expect(received).toBe(input);
    expect(writeCallback).toBe(true);
    expect(endCallback).toBe(true);
    expect(JSON.stringify(receipts)).not.toContain("PRIVATE");
    return receipts;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it("observes the real HTTP response without changing bytes, headers, callbacks or private content", async () => {
  const receipts = await exchange(200, {
    result: {
      isError: true,
      structuredContent: { error: { _tag: "NotGranted", message: "PRIVATE_ERROR" } },
    },
  });
  expect(receipts).toEqual([
    {
      method: "tools/call",
      sessionHeader: true,
      status: 200,
      bounded: true,
      requestDecoded: true,
      responseDecoded: true,
      outcome: "NotGranted",
      completed: true,
    },
  ]);
  expect(
    (await exchange(200, { result: { text: "PRIVATE_RESULT_💙" } }, undefined, undefined, true))[0]
      ?.outcome,
  ).toBe("ok");
  expect(await exchange(200, { result: {} }, undefined, "/unrelated")).toEqual([]);
});

it("distinguishes fixed transport and RPC failures without retaining their detail strings", async () => {
  expect(
    (await exchange(404, { error: "expired_mcp_session", detail: "PRIVATE_DETAIL" }))[0]?.outcome,
  ).toBe("expired-session");
  expect(
    (await exchange(401, { error: "invalid_mcp_credential", token: "PRIVATE_TOKEN" }))[0]?.outcome,
  ).toBe("credential-refused");
  expect(
    (await exchange(200, { error: { code: -32602, message: "PRIVATE_ARGUMENT" } }))[0]?.outcome,
  ).toBe("rpc-invalid-params");
  expect(
    (
      await exchange(200, {
        result: { isError: true, structuredContent: { error: { _tag: "PRIVATE_TAG" } } },
      })
    )[0]?.outcome,
  ).toBe("tool-error");
});

it("records a closed connection separately from completed tool results", async () => {
  let receipt!: RehearsalMcpTransportReceipt;
  let resolve!: () => void;
  const observed = new Promise<void>((done) => {
    resolve = done;
  });
  const server = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => response.destroy());
  });
  server.prependListener("request", (request, response) =>
    observeComputerMcpRequest(request, response, (value) => {
      receipt = value;
      resolve();
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await expect(
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/computer`, {
        method: "POST",
        body: JSON.stringify({ method: "tools/call", params: { text: "PRIVATE_TEXT" } }),
      }),
    ).rejects.toThrow();
    await observed;
    expect(receipt).toMatchObject({
      method: "tools/call",
      completed: false,
      outcome: "connection-closed",
    });
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE");
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  }
});

it("bounds raw bytes and labels incomplete diagnostics without interfering with the response", async () => {
  const large = "PRIVATE_".repeat(10000);
  expect((await exchange(200, { result: { text: large } }))[0]).toMatchObject({
    bounded: false,
    responseDecoded: false,
    outcome: "unreadable",
  });
  expect(
    (
      await exchange(
        200,
        { result: {} },
        JSON.stringify({ method: "tools/call", params: { text: large } }),
      )
    )[0],
  ).toMatchObject({ bounded: false, requestDecoded: false, method: "other" });
});
