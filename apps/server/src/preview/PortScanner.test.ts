import { assert, describe, it } from "@effect/vitest";

import { parseLsofOutput, parsePortFromLsofName, parseWindowsListenerOutput } from "./PortScanner";

describe("preview port scanner parsers", () => {
  it("parses local lsof listener names", () => {
    assert.equal(parsePortFromLsofName("*:5173"), 5173);
    assert.equal(parsePortFromLsofName("127.0.0.1:3000"), 3000);
    assert.equal(parsePortFromLsofName("[::1]:8080"), 8080);
    assert.equal(parsePortFromLsofName("192.168.1.10:3000"), null);
  });

  it("parses lsof field output into sorted local servers", () => {
    const servers = parseLsofOutput("p123\ncVite\nn*:5173\np456\ncNext\nn127.0.0.1:3000\n");
    assert.deepEqual(
      servers.map((server) => ({
        port: server.port,
        processName: server.processName,
        pid: server.pid,
      })),
      [
        { port: 3000, processName: "Next", pid: 456 },
        { port: 5173, processName: "Vite", pid: 123 },
      ],
    );
  });

  it("parses Windows listener output into sorted local servers", () => {
    const servers = parseWindowsListenerOutput("127.0.0.1|5173|123|Vite\n0.0.0.0|3000|456|Next\n");
    assert.deepEqual(
      servers.map((server) => ({
        port: server.port,
        processName: server.processName,
        pid: server.pid,
      })),
      [
        { port: 3000, processName: "Next", pid: 456 },
        { port: 5173, processName: "Vite", pid: 123 },
      ],
    );
  });
});
