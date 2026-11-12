import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeBypassAvailability } from "./claudeBypassAvailability.ts";
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ resolveSettings: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

it("combines isolated home, remote cache and effective managed restrictions", async () => {
  vi.spyOn(fs, "readFile").mockImplementation(async (path) =>
    String(path).endsWith("remote-settings.json")
      ? '{"managedSourcesBehavior":"merge","permissions":{"disableBypassPermissionsMode":"disable"}}'
      : '{"disableAutoMode":"disable"}',
  );
  const resolve = vi.spyOn(sdk, "resolveSettings").mockResolvedValue({
    effective: {},
    sources: [],
    provenance: {},
  });
  expect(await resolveClaudeBypassAvailability("/profile", "/repo")).toEqual({
    bypassDisabled: true,
    autoDisabled: true,
  });
  expect(resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      cwd: "/repo",
      settingSources: ["project", "local"],
      serverManagedSettings: expect.objectContaining({ managedSourcesBehavior: "merge" }),
    }),
  );
});

it("fails closed on unreadable policy without caching the failure", async () => {
  const read = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("unreadable"));
  expect((await resolveClaudeBypassAvailability("/profile", "/repo")).bypassDisabled).toBe(true);
  expect((await resolveClaudeBypassAvailability("/profile", "/repo")).failureReason).toContain(
    "Could not read remote-settings.json",
  );
  read.mockResolvedValue("{}");
  vi.spyOn(sdk, "resolveSettings").mockResolvedValue({
    effective: {},
    sources: [],
    provenance: {},
  });
  expect((await resolveClaudeBypassAvailability("/profile", "/repo")).bypassDisabled).toBe(false);
});

it("accepts comments and trailing commas in Claude settings", async () => {
  vi.spyOn(fs, "readFile").mockResolvedValue(
    '{\n// policy\n"permissions": {"disableBypassPermissionsMode": "disable",},\n}',
  );
  vi.spyOn(sdk, "resolveSettings").mockResolvedValue({
    effective: {},
    sources: [],
    provenance: {},
  });
  expect(await resolveClaudeBypassAvailability("/profile", "/repo")).toEqual({
    bypassDisabled: true,
    autoDisabled: false,
  });
});

it("reports parse failures without including settings contents", async () => {
  vi.spyOn(fs, "readFile").mockResolvedValue('{"privateValue": "do-not-report",');
  const result = await resolveClaudeBypassAvailability("/profile", "/repo");
  expect(result.bypassDisabled).toBe(true);
  expect(result.failureReason).toContain("Could not parse remote-settings.json");
  expect(result.failureReason).not.toContain("do-not-report");
});
