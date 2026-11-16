/**
 * Scripted Muse Session Protocol host over stdio, for transport and
 * lifecycle tests. Serves `MockMspHost` defaults; environment switches cover
 * the process-level cases:
 *
 * - `MSP_MOCK_STDERR`: text written to stderr at startup.
 * - `MSP_MOCK_STAY_ALIVE=1`: keep running after stdin closes.
 * - `MSP_MOCK_IGNORE_SIGTERM=1`: ignore SIGTERM (forces SIGKILL escalation).
 * - `MSP_MOCK_FINGERPRINT`: schema fingerprint to advertise.
 */
import { Utf8Lines } from "@t3tools/shared/utf8Lines";
import { MockMspHost } from "../src/provider/msp/testing/mockMspHost.ts";

const host = new MockMspHost(
  process.env.MSP_MOCK_FINGERPRINT ? { fingerprint: process.env.MSP_MOCK_FINGERPRINT } : {},
);

// A real process can be killed after a visible prefix but before completion.
if (process.env.MSP_MOCK_STREAM_TURN === "1") {
  host.handlers.set("turn/start", (params, host) => {
    const turnId = `turn-${++host.turnCounter}`;
    setTimeout(() => {
      host.notify("turn/started", { turnId, commandId: params.commandId });
      host.notify("item/started", {
        item: {
          itemId: "chaos-assistant",
          kind: "agentMessage",
          revision: 1,
          status: "inProgress",
          turnId,
          text: "",
        },
      });
      host.notify("item/delta", { itemId: "chaos-assistant", delta: "Muse prefix " });
      if (process.env.MSP_MOCK_COMPLETE_ITEM === "1")
        host.notify("item/completed", {
          item: {
            itemId: "chaos-assistant",
            kind: "agentMessage",
            revision: 2,
            status: "completed",
            turnId,
            text: "Muse prefix ",
          },
        });
    }, 0);
    return {
      commandId: params.commandId,
      disposition: "started",
      startedNewTurn: true,
      status: "accepted",
      turnId,
    };
  });
}

if (process.env.MSP_MOCK_STDERR) process.stderr.write(process.env.MSP_MOCK_STDERR);
if (process.env.MSP_MOCK_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => undefined);

const inputLines = new Utf8Lines();
process.stdin.on("data", (chunk: Buffer) => {
  for (const line of inputLines.push(chunk)) {
    if (
      process.env.MSP_MOCK_EXIT_METHOD &&
      JSON.parse(line).method === process.env.MSP_MOCK_EXIT_METHOD
    )
      process.exit(23);
    void host.transport.write(`${line}\n`);
  }
});
process.stdin.on("end", () => {
  if (process.env.MSP_MOCK_STAY_ALIVE !== "1") process.exit(0);
  setInterval(() => undefined, 1_000);
});

void (async () => {
  for await (const chunk of host.transport.incoming) process.stdout.write(chunk);
})();
