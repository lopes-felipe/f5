import { describe, expect, it } from "vitest";
import { ProviderKind, ComputerAutomationUnavailableReason } from "@t3tools/contracts";
import {
  AGENT_AUTOMATION_SUPPORT,
  COMPUTER_UNAVAILABLE_LABEL,
  computerAgentProviderFor,
  ACP_COMPUTER_CATALOG_VERIFIED,
  ACP_PREVIEW_CATALOG_VERIFIED,
} from "./agentAutomationSupport";
import { computerToolHeading } from "./computerAction";

describe("automation support reporting", () => {
  it("covers every provider and reason without opening any ACP gate", () => {
    for (const kind of ProviderKind.literals) expect(AGENT_AUTOMATION_SUPPORT[kind]).toBeDefined();
    for (const reason of ComputerAutomationUnavailableReason.literals)
      expect(COMPUTER_UNAVAILABLE_LABEL[reason]).toBeTruthy();
    expect(computerAgentProviderFor("claudeAgent")).toBe("claude");
    expect(computerAgentProviderFor("opencode")).toBeUndefined();
    expect(computerAgentProviderFor("acp")).toBeUndefined();
    expect(Object.isFrozen(ACP_COMPUTER_CATALOG_VERIFIED)).toBe(true);
    expect(Object.isFrozen(ACP_PREVIEW_CATALOG_VERIFIED)).toBe(true);
    expect(Object.values(ACP_PREVIEW_CATALOG_VERIFIED)).toEqual([false, false, false, false]);
    expect(Object.values(ACP_COMPUTER_CATALOG_VERIFIED)).toEqual([false, false, false, false]);
  });
  it("names known operations and never interprets a server name as a tool", () => {
    expect(computerToolHeading("computer_wait", "completed")).toBe("Waited");
    expect(computerToolHeading("mcp__f5_computer__computer_click", "completed")).toBe("Clicked");
    expect(computerToolHeading("f5_computer", "completed")).toBeUndefined();
  });
});
