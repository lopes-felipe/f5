import { expect, it } from "vitest";
import { boundedHistoryRows, boundedHistoryStreams } from "./historyWindow.ts";

it("pages a huge agent turn losslessly in either direction", () => {
  const rows = Array.from({ length: 900 }, (_, id) => ({ id, text: "x".repeat(8000) }));
  for (const forward of [false, true]) {
    let remaining = rows;
    const loaded = [];
    while (remaining.length) {
      const page = boundedHistoryRows(remaining, forward);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(262_144);
      expect(page.length).toBeGreaterThan(0);
      loaded.push(...page);
      remaining = forward ? remaining.slice(page.length) : remaining.slice(0, -page.length);
    }
    expect(loaded.map((row) => row.id).sort((a, b) => a - b)).toEqual(rows.map((row) => row.id));
  }
});

it("caps user turns and permits an oversized row to make progress", () => {
  const rows = Array.from({ length: 30 }, (_, id) => ({ id, role: "user" }));
  expect(boundedHistoryRows(rows, false, (row) => row.role === "user")).toHaveLength(10);
  expect(boundedHistoryRows([{ text: "x".repeat(1_048_576) }])).toHaveLength(1);
});

it("marks truncation on the correct side of each independent cursor", () => {
  const rows = Array.from({ length: 300 }, (_, id) => ({ id, role: "assistant" }));
  const page = boundedHistoryStreams(
    {
      messages: rows,
      activities: rows,
      checkpoints: rows,
      commandExecutions: rows,
      hasOlderMessages: false,
      hasOlderActivities: false,
      hasOlderCheckpoints: false,
      hasOlderCommandExecutions: false,
    },
    true,
    false,
  );
  expect(page.messages[0]?.id).toBe(0);
  expect(page.activities[0]?.id).toBe(175);
  expect(page.hasOlderMessages).toBe(false);
  expect(page).toMatchObject({ hasNewerMessages: true, hasOlderActivities: true });
});
