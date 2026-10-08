import { describe, expect, it } from "vitest";

import { buildCodexTurnStartParams, readCodexAccountSnapshot } from "../codexAppServerManager.ts";
import {
  parseCodexInstanceSkills,
  parseCodexModelList,
  readCodexReportedModelCapabilities,
} from "./codexModelCatalog.ts";

const MODEL_LIST = {
  data: [
    {
      id: "gpt-cli-only",
      model: "gpt-cli-only",
      displayName: "CLI Only",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "ultra", description: "" },
      ],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "fast", name: "Fast" }],
      additionalSpeedTiers: ["turbo"],
      upgrade: "gpt-cli-next",
    },
    { id: "gpt-hidden", model: "gpt-hidden", hidden: true },
  ],
};

describe("parseCodexModelList", () => {
  it("drops hidden models and keeps reported capabilities", () => {
    const models = parseCodexModelList(MODEL_LIST.data);
    expect(models.map((model) => model.slug)).toEqual(["gpt-cli-only"]);
    expect(models[0]?.name).toBe("CLI Only");
    expect(models[0]?.capabilities.source).toBe("reported");
    expect(models[0]?.capabilities.upgradeTo).toBe("gpt-cli-next");
    expect(models[0]?.capabilities.serviceTiers?.map((tier) => tier.id)).toEqual(["fast"]);
  });
});

describe("CLI-only model execution", () => {
  it("sends the reported effort on turn/start instead of the built-in fallback", () => {
    const params = buildCodexTurnStartParams(
      { threadId: "thread-1", input: "hello", model: "gpt-cli-only", effort: "ultra" } as never,
      {
        providerThreadId: "provider-thread-1",
        account: readCodexAccountSnapshot({ type: "chatgpt", planType: "pro" }),
        reportedModelCapabilities: readCodexReportedModelCapabilities(MODEL_LIST),
      },
    );
    expect(params.model).toBe("gpt-cli-only");
    expect(params.effort).toBe("ultra");
  });

  it("walks down to a reported effort when the requested one is not offered", () => {
    const params = buildCodexTurnStartParams(
      { threadId: "thread-1", input: "hello", model: "gpt-cli-only", effort: "medium" } as never,
      {
        providerThreadId: "provider-thread-1",
        account: readCodexAccountSnapshot({ type: "chatgpt", planType: "pro" }),
        reportedModelCapabilities: readCodexReportedModelCapabilities(MODEL_LIST),
      },
    );
    expect(params.effort).toBe("low");
  });
});

describe("parseCodexInstanceSkills", () => {
  it("keeps instance skills and leaves repo skills to the project scan", () => {
    expect(
      parseCodexInstanceSkills([
        {
          cwd: "/repo",
          skills: [
            { name: "mine", path: "/home/.codex/skills/mine/SKILL.md", scope: "user" },
            { name: "shared", path: "/repo/.codex/skills/shared/SKILL.md", scope: "repo" },
          ],
        },
      ]).map((skill) => skill.name),
    ).toEqual(["mine"]);
  });
});
