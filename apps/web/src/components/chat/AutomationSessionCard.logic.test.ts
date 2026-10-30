import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../session-logic";
import {
  automationRunEnd,
  automationStepDetail,
  buildAutomationRun,
  classifyAutomationEntry,
  coalesceAutomationChips,
  summarizeAutomationRun,
} from "./AutomationSessionCard.logic";

let sequence = 0;
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 30, 18, 0, seconds)).toISOString();

function computer(
  tool: string,
  overrides: Partial<WorkLogEntry> = {},
  seconds = sequence,
): WorkLogEntry {
  sequence += 1;
  return {
    id: `c${sequence}`,
    createdAt: at(seconds),
    tone: "tool",
    label: tool,
    itemType: "mcp_tool_call",
    status: "completed",
    mcpServerName: "f5_computer",
    mcpToolName: `computer_${tool}`,
    computerTool: true,
    ...overrides,
  };
}

function preview(
  tool: string,
  input?: Record<string, unknown>,
  overrides: Partial<WorkLogEntry> = {},
) {
  sequence += 1;
  return {
    id: `p${sequence}`,
    createdAt: at(sequence),
    tone: "tool",
    label: tool,
    itemType: "mcp_tool_call",
    status: "completed",
    mcpServerName: "f5_preview",
    mcpToolName: `preview_${tool}`,
    ...(input ? { mcpInput: JSON.stringify(input) } : {}),
    ...overrides,
  } satisfies WorkLogEntry;
}

const thinking = (): WorkLogEntry => {
  sequence += 1;
  return { id: `t${sequence}`, createdAt: at(sequence), tone: "thinking", label: "Thinking" };
};

const other = (): WorkLogEntry => {
  sequence += 1;
  return {
    id: `o${sequence}`,
    createdAt: at(sequence),
    tone: "tool",
    label: "Read file",
    itemType: "command_execution",
    command: "cat a.ts",
  };
};

describe("classifyAutomationEntry", () => {
  it("needs F5's marker for computer calls and a known server for preview calls", () => {
    expect(classifyAutomationEntry(computer("click"))).toBe("computer");
    expect(classifyAutomationEntry(computer("click", { computerTool: false }))).toBeUndefined();
    expect(classifyAutomationEntry(preview("click"))).toBe("preview");
    expect(classifyAutomationEntry(preview("click", undefined, { mcpServerName: "evil" }))).toBe(
      undefined,
    );
    expect(classifyAutomationEntry(other())).toBeUndefined();
  });
});

describe("automationRunEnd", () => {
  const end = (entries: WorkLogEntry[]) => automationRunEnd(entries, 0, (entry) => entry);

  it("absorbs thinking between calls and trims it from the end", () => {
    expect(end([computer("click"), thinking(), computer("key"), thinking()])).toBe(3);
  });

  it("stops at another tool or surface", () => {
    expect(end([computer("click"), other(), computer("key")])).toBe(1);
    expect(end([computer("click"), preview("click")])).toBe(1);
  });
});

describe("coalesceAutomationChips", () => {
  it("merges consecutive same-op, same-status calls", () => {
    const { chips } = coalesceAutomationChips([
      computer("key"),
      computer("key"),
      computer("key", { status: "failed" }),
      computer("click"),
      computer("click"),
    ]);
    expect(chips.map((chip) => [chip.op, chip.count, chip.failed])).toEqual([
      ["key", 2, false],
      ["key", 1, true],
      ["click", 2, false],
    ]);
  });

  it("keeps the newest chips and counts the hidden actions", () => {
    const entries = Array.from({ length: 30 }, (_, index) => computer(index % 2 ? "click" : "key"));
    const { chips, hiddenCount } = coalesceAutomationChips(entries, 24);
    expect(chips).toHaveLength(24);
    expect(hiddenCount).toBe(6);
    expect(chips.at(-1)?.key).toBe(entries.at(-1)?.id);
  });
});

describe("buildAutomationRun", () => {
  it("titles a finished run by its apps, with duration and failures", () => {
    const run = buildAutomationRun("computer", [
      computer("activate_app", { computerStep: { appName: "Google Chrome" } }, 0),
      thinking(),
      computer("click", { computerStep: { appName: "Google Chrome" }, status: "failed" }, 30),
      computer("type", { computerStep: { appName: "Finder" } }, 72),
    ]);
    expect(run).toMatchObject({
      title: "Used Google Chrome, Finder",
      actionCount: 3,
      failedCount: 1,
      status: "done",
      duration: "1m 12s",
    });
  });

  it("collapses many apps and names the live action while running", () => {
    const apps = ["A", "B", "C", "D"].map((appName) =>
      computer("click", { computerStep: { appName } }),
    );
    expect(buildAutomationRun("computer", apps).title).toBe("Used A, B +2");
    expect(
      buildAutomationRun("computer", [
        ...apps,
        computer("click", { status: "inProgress", computerStep: { appName: "Chrome" } }),
      ]),
    ).toMatchObject({ title: "Clicking… · Chrome", status: "running" });
  });

  it("treats an idle turn's in-progress call as interrupted, not running", () => {
    const entries = [
      computer("key", { computerStep: { appName: "Chrome" } }),
      computer("click", { status: "inProgress", computerStep: { appName: "Chrome" } }),
    ];
    const run = buildAutomationRun("computer", entries, false);
    expect(run).toMatchObject({ status: "done", title: "Used Chrome" });
    expect(run.chips.at(-1)).toMatchObject({ running: false, title: "Clicking interrupted" });
    expect(summarizeAutomationRun("computer", entries, false)).toBe("Used Chrome · 2 actions");
  });

  it("leaves entries with embedded UI out of runs", () => {
    expect(
      classifyAutomationEntry(
        preview("snapshot", undefined, {
          htmlRender: { title: "Snapshot", height: 200, attachmentId: "a" },
        }),
      ),
    ).toBeUndefined();
  });

  it("marks a run whose last action failed", () => {
    expect(
      buildAutomationRun("computer", [computer("click"), computer("key", { status: "failed" })])
        .status,
    ).toBe("failed");
  });

  it("names the preview host and gathers screenshots", () => {
    const image = { attachmentId: "shot", mimeType: "image/png", sizeBytes: 1 };
    const run = buildAutomationRun("preview", [
      preview("navigate", { url: "http://localhost:5173/settings" }),
      preview("screenshot", undefined, { mcpImages: [image], mcpImagesOmitted: 2 }),
    ]);
    expect(run).toMatchObject({
      title: "Used browser preview · localhost:5173",
      images: [{ attachmentId: "shot", mimeType: "image/png" }],
      omittedImageCount: 2,
    });
    expect(summarizeAutomationRun("preview", [preview("click")])).toBe(
      "Used browser preview · 1 action",
    );
  });
});

describe("automationStepDetail", () => {
  it("describes computer steps from the safe summary only", () => {
    expect(
      automationStepDetail(
        computer("key", { computerStep: { appName: "Chrome", keyChord: "Meta+L", repeat: 2 } }),
      ),
    ).toBe("Chrome · Meta+L ×2");
    expect(
      automationStepDetail(
        computer("type", { computerStep: { typedLength: 24 }, mcpInput: '{"text":"secret"}' }),
      ),
    ).toBe("24 characters");
    expect(automationStepDetail(computer("click", { computerStep: { x: 640, y: 212 } }))).toBe(
      "640, 212",
    );
  });

  it("describes preview steps without echoing typed text", () => {
    expect(automationStepDetail(preview("navigate", { url: "https://example.com/a/b" }))).toBe(
      "example.com/a/b",
    );
    expect(automationStepDetail(preview("click", { selector: "#save" }))).toBe("#save");
    expect(automationStepDetail(preview("type", { text: "hello" }))).toBe("5 characters");
    expect(automationStepDetail(preview("press", { key: "K", modifiers: ["Meta"] }))).toBe(
      "Meta+K",
    );
    expect(automationStepDetail(preview("viewport", { width: 390, height: 844 }))).toBe("390×844");
  });
});
