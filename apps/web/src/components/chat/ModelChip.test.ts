import { expect, it, vi } from "vitest";
import { getAppModelOptions } from "../../appSettings";
import { resolveModelChipName } from "./ModelChip";

vi.mock("../../appSettings", () => ({ getAppModelOptions: vi.fn() }));

it("formats synthesized custom names while preserving a supplied display name", () => {
  vi.mocked(getAppModelOptions).mockReturnValue([
    { slug: "claude-opus-6", name: "My Opus", isCustom: true },
  ]);
  expect(resolveModelChipName("claudeAgent", "claude-opus-6")).toBe("My Opus");
  vi.mocked(getAppModelOptions).mockReturnValue([
    { slug: "claude-opus-6", name: "claude-opus-6", isCustom: true },
  ]);
  expect(resolveModelChipName("claudeAgent", "claude-opus-6")).toBe("Claude Opus 6");
});
