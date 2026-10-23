import { describe, expect, it } from "vitest";
import {
  isMetadataOnlyScheduleEdit,
  confirmedSchedule,
  validateScheduledDraft,
  type PreviewState,
} from "./schedulePreview";
import type { ScheduledTaskConfiguration } from "@t3tools/contracts";
const preview = {
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  summary: "Weekdays at 9",
  nextFireTimes: ["2026-10-23T09:00:00Z"],
  oneShotAt: null,
};
describe("schedule confirmation", () => {
  it("does not save unpreviewed, loading or failed conversions", () => {
    const states: PreviewState[] = [
      { kind: "unpreviewed" },
      { kind: "loading", key: "a" },
      { kind: "error", key: "a", message: "failed" },
    ];
    for (const state of states) expect(confirmedSchedule(state, "a")).toBeNull();
  });
  it("accepts a shown cron or preset preview", () => {
    expect(confirmedSchedule({ kind: "ready", key: "a", preview }, "a")).toBe(preview);
  });
  it("invalidates changed inputs and stale responses", () => {
    expect(
      confirmedSchedule(
        { kind: "ready", key: "old-project-zone-input", preview },
        "new-project-zone-input",
      ),
    ).toBeNull();
  });
  it("requires a new preview after a one-shot expires", () => {
    expect(
      confirmedSchedule(
        { kind: "ready", key: "a", preview: { ...preview, oneShotAt: "2026-01-01T00:00:00Z" } },
        "a",
        Date.parse("2026-01-02"),
      ),
    ).toBeNull();
  });
  it("requires prompt, name, model and explicit workspace configuration", () => {
    const value = {
      name: "Check",
      prompt: "Run tests",
      modelSelection: { instanceId: "codex", model: "model" },
      workspace: { kind: "projectRoot" },
    } as ScheduledTaskConfiguration;
    expect(validateScheduledDraft(value)).toBeNull();
    for (const patch of [
      { name: "" },
      { prompt: "" },
      { prompt: "/plan" },
      { workspace: { kind: "worktree", baseBranch: "" } },
    ])
      expect(
        validateScheduledDraft({ ...value, ...patch } as ScheduledTaskConfiguration),
      ).toBeTruthy();
  });
});

it("allows metadata-only editing of expired schedules without changing their execution", () => {
  const original = {
    name: "Old",
    prompt: "Check",
    enabled: false,
    cron: "0 0 15 1 1 * 2020",
    timezone: "UTC",
    oneShotAt: "2020-01-01T15:00:00Z",
    maxRuns: 1,
    workspace: { kind: "projectRoot" },
    modelSelection: { instanceId: "codex", model: "m" },
    runtimeMode: "approval-required",
    notify: "all",
    scheduleSource: "once",
  } as ScheduledTaskConfiguration;
  expect(
    isMetadataOnlyScheduleEdit(original, { ...original, name: "Renamed", notify: "none" }),
  ).toBe(true);
  expect(isMetadataOnlyScheduleEdit(original, { ...original, prompt: "Other" })).toBe(false);
  expect(isMetadataOnlyScheduleEdit(original, { ...original, enabled: true })).toBe(false);
});
