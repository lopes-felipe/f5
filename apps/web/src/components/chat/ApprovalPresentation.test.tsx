import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PendingApproval } from "../../session-logic";
import { ApprovalPresentation } from "./ApprovalPresentation";

describe("approval rule sources", () => {
  it.each([
    ["policySettings", "Contact your administrator"],
    ["cliArg", "launch configuration"],
    ["userSettings", "matching rule and its source"],
  ])("explains %s", (askRuleSource, expected) => {
    const approval = {
      presentation: { fullAccessOverride: "ask_rule", askRuleSource },
    } as PendingApproval;
    const html = renderToStaticMarkup(<ApprovalPresentation approval={approval} />);
    expect(html).toContain(expected);
    expect(html).not.toContain("Remove or narrow");
  });
});
