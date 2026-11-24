import { describe, expect, it } from "vitest";
import { projectAntigravityCapture } from "./AntigravityCapture.ts";
import upstreamFixture from "./fixtures/antigravity/upstream-initialize.fixture.json" with { type: "json" };

const meta = {
  agyVersion: "1.2.3",
  platform: "darwin",
  authMethod: "oauth-personal",
  accountTier: "free",
  capturedOn: "2026-11-22",
};

describe("Antigravity capture projection", () => {
  it("keeps IDs, option values and field presence and drops everything else", () => {
    const secret = "user@example.com";
    const fixture = projectAntigravityCapture(
      {
        initialize: {
          agentInfo: { name: secret },
          authMethods: [{ id: "oauth-personal", name: secret }, { id: "gemini-api-key" }],
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false },
            _meta: { account: secret },
          },
        },
        helpText: `Usage: agy acp [--model <id>] --yolo\n  --api-key ${secret}`,
        session: {
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: secret },
              { id: "plan", description: secret },
            ],
          },
          configOptions: [
            {
              id: "model",
              type: "select",
              category: "model",
              currentValue: "neon",
              options: [
                { value: "neon", name: secret },
                { group: "more", options: [{ value: "carbon", name: secret }] },
              ],
            },
          ],
          commands: [{ name: "review", description: secret }, { name: "has space" }],
        },
        models: [
          {
            id: "neon",
            configOptions: [
              {
                id: "thought_level",
                type: "select",
                category: "thought_level",
                currentValue: "medium",
                options: [{ value: "low" }, { value: "medium" }],
              },
            ],
          },
          { id: "orchestrator", configOptions: [] },
        ],
        permissions: [
          {
            step: "edit",
            sessionMode: "default",
            request: {
              toolCall: {
                kind: "edit",
                title: secret,
                rawInput: { TargetFile: `/Users/${secret}/a.ts` },
              },
              options: [{ kind: "allow_once", name: secret }, { kind: "reject_once" }],
            },
          },
        ],
        usageFrames: [{ sessionUpdate: "usage_update", used: 12, size: 100 }],
        promptResponses: [{ stopReason: "end_turn", usage: { inputTokens: 3, prompt: secret } }],
        resume: { ok: true, response: { configOptions: [] } },
        checks: { apiKeyVisibleToShell: false, executedProjectHooks: [] },
      },
      meta,
    );

    expect(JSON.stringify(fixture)).not.toContain(secret);
    expect(JSON.stringify(fixture)).not.toContain("Users");
    expect(fixture.initialize).toEqual({
      authMethodIds: ["oauth-personal", "gemini-api-key"],
      capabilityFlags: {
        loadSession: true,
        "promptCapabilities.image": true,
        "promptCapabilities.audio": false,
      },
    });
    expect(fixture.helpFlags).toEqual(["--api-key", "--model", "--yolo"]);
    expect(fixture.session).toEqual({
      modeIds: ["default", "plan"],
      currentModeId: "default",
      configOptions: [
        { id: "model", category: "model", type: "select", values: ["neon", "carbon"] },
      ],
      commandNames: ["review"],
    });
    expect(fixture.models).toEqual([
      { id: "neon", thoughtLevels: ["low", "medium"], defaultLevel: "medium" },
      { id: "orchestrator", thoughtLevels: null, defaultLevel: null },
    ]);
    expect(fixture.permissions).toEqual([
      {
        step: "edit",
        sessionMode: "default",
        toolKind: "edit",
        optionKinds: ["allow_once", "reject_once"],
        fieldsPresent: [
          "toolCall.kind",
          "toolCall.rawInput",
          "toolCall.rawInput.TargetFile",
          "toolCall.title",
        ],
      },
    ]);
    expect(fixture.usage).toEqual({
      frames: 1,
      frameFields: ["sessionUpdate", "size", "used"],
      promptResponseFields: ["stopReason", "usage", "usage.inputTokens", "usage.prompt"],
    });
  });

  it("rejects a capture date with more than the calendar day", () => {
    expect(
      projectAntigravityCapture({}, { ...meta, capturedOn: "2026-11-22T10:00:00Z" }).meta
        .capturedOn,
    ).toBe("unknown");
  });

  it("keeps the committed upstream-derived fixture in the projected shape", () => {
    expect(upstreamFixture.fixtureVersion).toBe(1);
    expect(upstreamFixture.meta.upstream?.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(upstreamFixture.initialize.authMethodIds).toContain("oauth-personal");
    // A capture that ran no checks projects to exactly this block.
    expect(upstreamFixture.checks).toEqual(projectAntigravityCapture({}, meta).checks);
  });

  it("keeps unknown hook execution distinct from none and records rejected modes", () => {
    const projected = projectAntigravityCapture(
      { checks: { executedProjectHooks: ["pre-commit"], rejectedModes: ["auto"] } },
      meta,
    );
    expect(projected.checks.executedProjectHooks).toEqual(["pre-commit"]);
    expect(projected.checks.rejectedModes).toEqual(["auto"]);
    expect(projectAntigravityCapture({}, meta).checks.executedProjectHooks).toBeNull();
  });
});
