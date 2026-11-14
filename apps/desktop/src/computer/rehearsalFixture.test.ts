import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { observeRehearsalFixture, configureWindowsPerformanceFixture } from "./rehearsalFixture";

it("rebuilds the tree and delayed-input mode after every full Windows reset", async () => {
  const events: string[] = [];
  const fixture = await configureWindowsPerformanceFixture(
    {
      reset: async () => {
        events.push("reset");
      },
      command: vi.fn(async (command: string, _receipt: string) => {
        events.push(command);
      }),
    },
    { treeNodes: 380, delayedFocus: true },
  );
  await fixture.reset();
  await fixture.reset();
  expect(events).toEqual([
    "performance-tree 380",
    "performance-delayed-input",
    "reset",
    "performance-tree 380",
    "performance-delayed-input",
    "reset",
    "performance-tree 380",
    "performance-delayed-input",
  ]);
});

it.each(["status", "observation"])("parses real Windows %s receipts", async (kind) => {
  const child = new ChildProcess() as any;
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  const ready = observeRehearsalFixture(child, "fixture");
  child.stdout.write("FIXTURE_READY\n");
  const fixture = await ready;
  child.stdin.on("data", () => {
    const receipt = { presses: 1, expectedSyntheticTextReceived: true };
    child.stdout.write("FIXTURE_ENTERED\n");
    child.stdout.write(
      JSON.stringify({
        kind,
        state: kind === "status" ? receipt : { receipt },
      }) + "\n",
    );
  });
  expect(await fixture.verify()).toEqual({ presses: 1, expectedText: true, entered: true });
  child.stdout.end();
  child.stdin.end();
});
