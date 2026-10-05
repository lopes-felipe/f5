import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../types";
import { HomeAttentionCard, attentionCardActionLabel } from "./HomeAttentionCard";
import { resolveGreeting } from "./HomeMissionControl";
import { appendQuickStartText } from "./HomeQuickStart";
import { HomeThreadRow } from "./HomeThreadRow";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1" as never,
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Wire up the dashboard",
    model: "gpt-5",
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    commandExecutions: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    lastInteractionAt: "2026-03-09T10:05:00.000Z",
    estimatedContextTokens: null,
    estimatedThinkingTokens: null,
    modelContextWindowTokens: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    detailsLoaded: true,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    ...overrides,
  };
}

describe("appendQuickStartText", () => {
  it("uses the text as-is for an empty draft", () => {
    expect(appendQuickStartText("", "Fix the bug")).toBe("Fix the bug");
    expect(appendQuickStartText("  \n", "Fix the bug")).toBe("Fix the bug");
  });

  it("appends on a new line and keeps the existing prefix intact", () => {
    expect(appendQuickStartText("@src/app.ts ", "add tests")).toBe("@src/app.ts \nadd tests");
    expect(appendQuickStartText("first line\n", "second")).toBe("first line\nsecond");
  });
});

describe("attentionCardActionLabel", () => {
  it("names the action for each attention status", () => {
    expect(attentionCardActionLabel("plan-ready")).toBe("Review plan");
    expect(attentionCardActionLabel("awaiting-input")).toBe("Answer");
    expect(attentionCardActionLabel("pending-approval")).toBe("Review approval");
    expect(attentionCardActionLabel("working")).toBe("Open");
    expect(attentionCardActionLabel(undefined)).toBe("Open");
  });
});

describe("resolveGreeting", () => {
  it("follows the time of day", () => {
    expect(resolveGreeting(3)).toBe("Good evening");
    expect(resolveGreeting(9)).toBe("Good morning");
    expect(resolveGreeting(14)).toBe("Good afternoon");
    expect(resolveGreeting(21)).toBe("Good evening");
  });
});

describe("HomeAttentionCard", () => {
  it("puts the keyboard index on its action button", () => {
    const markup = renderToStaticMarkup(
      <HomeAttentionCard
        thread={makeThread()}
        project={undefined}
        status="awaiting-input"
        reasonTag="waiting 5m"
        rowIndex={2}
        onOpen={() => {}}
      />,
    );
    expect(markup).toContain('data-slot="home-attention-card"');
    expect(markup).toContain('data-status="awaiting-input"');
    expect(markup).toMatch(/<button[^>]*data-home-row-index="2"[^>]*>Answer/);
    expect(markup).toContain("waiting 5m");
  });
});

describe("HomeThreadRow", () => {
  it("renders no status chip for an idle thread", () => {
    const markup = renderToStaticMarkup(
      <HomeThreadRow thread={makeThread()} project={undefined} onSelect={() => {}} />,
    );
    expect(markup).toContain("Wire up the dashboard");
    expect(markup).not.toContain("Idle");
  });
});
