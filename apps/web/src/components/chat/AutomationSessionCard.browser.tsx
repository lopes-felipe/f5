import "../../index.css";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { WorkLogEntry } from "../../session-logic";
import { AutomationSessionCard } from "./AutomationSessionCard";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

const image = (attachmentId: string) => ({ attachmentId, mimeType: "image/png", sizeBytes: 1 });

function step(id: string, tool: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
  return {
    id,
    createdAt: `2026-10-30T18:00:${id.padStart(2, "0")}.000Z`,
    tone: "tool",
    label: tool,
    itemType: "mcp_tool_call",
    status: "completed",
    mcpServerName: "f5_computer",
    mcpToolName: `computer_${tool}`,
    computerTool: true,
    computerStep: { appName: "Google Chrome" },
    ...overrides,
  };
}

const entries: WorkLogEntry[] = [
  step("1", "activate_app"),
  step("2", "key", { computerStep: { appName: "Google Chrome", keyChord: "Meta+L" } }),
  step("3", "key"),
  step("4", "click", { status: "failed", computerStep: { outcome: "TargetBlocked" } }),
  step("5", "screenshot", {
    mcpImages: [image("a"), image("b"), image("c"), image("d")],
    mcpInput: '{"sanitized":true}',
    mcpResult: "Captured Google Chrome",
  }),
];

describe("AutomationSessionCard", () => {
  it("summarizes a run, opens screenshots and reveals each step", async () => {
    const onImageExpand = vi.fn();
    render(
      <AutomationSessionCard
        surface="computer"
        entries={entries}
        timestampFormat="24-hour"
        markdownCwd={undefined}
        onImageExpand={onImageExpand}
      />,
    );

    await expect
      .element(page.getByTestId("automation-session-title"))
      .toHaveTextContent("Used Google Chrome");
    await expect.element(page.getByText("5 actions · 4.0s")).toBeVisible();
    await expect.element(page.getByText("1 failed")).toBeVisible();
    // Two key presses share one chip; the failed click stays separate.
    const chips = page.getByRole("list", { name: "Actions" }).getByRole("listitem");
    await expect.poll(() => chips.elements().length).toBe(4);
    await expect.element(page.getByText("×2")).toBeVisible();
    expect(document.querySelector('[data-failed="true"][title="Clicking failed"]')).not.toBeNull();

    // The filmstrip shows the newest three; the "+1" tile opens the earlier one.
    await expect
      .poll(() => page.getByTestId("automation-filmstrip").getByRole("img").elements().length)
      .toBe(3);
    await page.getByRole("button", { name: "Preview screenshot 4" }).click();
    expect(onImageExpand).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 3, images: expect.any(Array) }),
    );
    expect(onImageExpand.mock.lastCall?.[0].images).toHaveLength(4);
    await page.getByRole("button", { name: "Show 1 earlier screenshots" }).click();
    expect(onImageExpand).toHaveBeenLastCalledWith(expect.objectContaining({ index: 0 }));

    await page.getByRole("button", { name: "Show 5 steps" }).click();
    const steps = page.getByTestId("automation-steps");
    await expect.element(steps.getByText("Meta+L")).toBeVisible();
    await expect.element(steps.getByText("Clicking failed")).toHaveClass(/text-destructive/);
    await expect.element(steps.getByText("TargetBlocked")).toBeVisible();

    await steps.getByText("Took a screenshot").click();
    await expect.element(steps.getByText("Captured Google Chrome")).toBeVisible();
    await expect.element(steps.getByText('{"sanitized":true}')).toBeVisible();
  });

  it("names the live action while a call is running", async () => {
    render(
      <AutomationSessionCard
        surface="computer"
        entries={[step("1", "click", { status: "inProgress" })]}
        timestampFormat="24-hour"
        markdownCwd={undefined}
        onImageExpand={() => {}}
      />,
    );
    await expect
      .element(page.getByTestId("automation-session-title"))
      .toHaveTextContent("Clicking… · Google Chrome");
    expect(
      document
        .querySelector('[data-testid="automation-session-card"]')
        ?.getAttribute("data-status"),
    ).toBe("running");
  });
});
