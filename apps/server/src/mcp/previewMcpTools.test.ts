import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import { DISABLED_AGENT_BROWSER_POLICY, type AgentBrowserPolicy } from "./browserAccess.ts";
import {
  makePreviewAutomationBroker,
  type PreviewAutomationInvokeInput,
} from "./PreviewAutomationBroker.ts";
import {
  callPreviewTool,
  chooseServerName,
  PREVIEW_TOOL_DEFINITIONS,
  previewToolInputJsonSchema,
} from "./previewMcpTools.ts";

const ENABLED: AgentBrowserPolicy = { ...DISABLED_AGENT_BROWSER_POLICY, previewAutomation: true };

function schemaFor(name: string) {
  const tool = PREVIEW_TOOL_DEFINITIONS.find((candidate) => candidate.name === name)!;
  return previewToolInputJsonSchema(tool) as {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

function recordingBroker() {
  const calls: PreviewAutomationInvokeInput[] = [];
  const base = makePreviewAutomationBroker();
  return {
    calls,
    broker: {
      ...base,
      invoke: <A>(input: PreviewAutomationInvokeInput) =>
        Effect.sync(() => {
          calls.push(input);
          return { ok: true } as A;
        }),
    },
  };
}

describe("preview tool catalog", () => {
  it("derives strict JSON schemas with the original property names and required fields", () => {
    const expected: Record<string, { properties: string[]; required: string[] }> = {
      preview_status: { properties: [], required: [] },
      preview_open: { properties: ["url", "show", "reuseExistingTab"], required: [] },
      preview_navigate: { properties: ["url", "target", "readiness", "timeoutMs"], required: [] },
      preview_snapshot: { properties: ["save"], required: [] },
      preview_click: { properties: ["selector", "locator", "x", "y", "timeoutMs"], required: [] },
      preview_type: {
        properties: ["text", "selector", "locator", "clear", "timeoutMs"],
        required: ["text"],
      },
      preview_press: { properties: ["key", "modifiers"], required: ["key"] },
      preview_scroll: { properties: ["deltaX", "deltaY", "selector", "locator"], required: [] },
      preview_evaluate: {
        properties: ["expression", "awaitPromise", "timeoutMs"],
        required: ["expression"],
      },
      preview_wait_for: {
        properties: ["selector", "locator", "text", "urlIncludes", "timeoutMs"],
        required: [],
      },
      preview_viewport: { properties: ["width", "height"], required: ["width", "height"] },
      preview_screenshot: { properties: [], required: [] },
      preview_recording_start: { properties: [], required: [] },
      preview_recording_stop: { properties: [], required: [] },
    };
    assert.deepEqual(
      PREVIEW_TOOL_DEFINITIONS.map((tool) => tool.name).toSorted(),
      Object.keys(expected).toSorted(),
    );
    for (const [name, shape] of Object.entries(expected)) {
      const schema = schemaFor(name);
      assert.equal(schema.type, "object", name);
      assert.equal(schema.additionalProperties, false, name);
      assert.deepEqual(
        Object.keys(schema.properties).toSorted(),
        shape.properties.toSorted(),
        name,
      );
      assert.deepEqual((schema.required ?? []).toSorted(), shape.required.toSorted(), name);
      assert.equal("$schema" in schema, false, name);
    }
  });

  it("keeps the 60 s timeout bound in the derived schema", () => {
    const timeout = schemaFor("preview_click").properties.timeoutMs as Record<string, unknown>;
    assert.equal(timeout.maximum, 60_000);
  });

  it("loads only status and open up front", () => {
    assert.deepEqual(
      PREVIEW_TOOL_DEFINITIONS.filter((tool) => tool.alwaysLoad).map((tool) => tool.name),
      ["preview_status", "preview_open"],
    );
  });

  it("suffixes colliding server names", () => {
    assert.equal(chooseServerName("f5_preview"), "f5_preview");
    assert.equal(chooseServerName("f5_preview", new Set(["f5_preview"])), "f5_preview_2");
    assert.equal(
      chooseServerName("f5_preview", new Set(["f5_preview", "f5_preview_2"])),
      "f5_preview_3",
    );
  });
});

describe("callPreviewTool", () => {
  const threadId = ThreadId.makeUnsafe("thread-tools");

  it("reports disabled status without reaching the broker", async () => {
    const { broker, calls } = recordingBroker();
    const context = {
      broker,
      policy: DISABLED_AGENT_BROWSER_POLICY,
      threadId,
      automationSessionId: "s",
    };
    const status = await callPreviewTool(context, "preview_status", {});
    assert.equal(status.isError, undefined);
    assert.equal((status.structuredContent as { reason?: string }).reason, "disabled");
    const click = await callPreviewTool(context, "preview_click", { selector: "#go" });
    assert.equal(click.isError, true);
    assert.equal(calls.length, 0);
  });

  it("passes the resolved policy through so the broker does not look it up again", async () => {
    const { broker, calls } = recordingBroker();
    await callPreviewTool(
      { broker, policy: ENABLED, threadId, automationSessionId: "s" },
      "preview_click",
      { selector: "#go" },
    );
    assert.equal(calls[0]?.policy, ENABLED);
    assert.equal(calls[0]?.automationSessionId, "s");
  });

  it("normalizes URLs against the per-call allowlist", async () => {
    const { broker, calls } = recordingBroker();
    const blocked = await callPreviewTool(
      { broker, policy: ENABLED, threadId, automationSessionId: "s" },
      "preview_open",
      { url: "example.com" },
    );
    assert.equal(blocked.isError, true);
    assert.equal(calls.length, 0);

    await callPreviewTool(
      {
        broker,
        policy: { ...ENABLED, externalHosts: ["example.com"] },
        threadId,
        automationSessionId: "s",
      },
      "preview_navigate",
      { url: "example.com/docs" },
    );
    assert.deepEqual((calls[0]!.input as { url?: string }).url, "https://example.com/docs");
  });

  it("returns the screenshot image to the agent and keeps the saved artifact", async () => {
    const calls: PreviewAutomationInvokeInput[] = [];
    const base = makePreviewAutomationBroker();
    const artifact = {
      artifactId: "preview-1",
      kind: "screenshot",
      mimeType: "image/png",
      bytes: 3,
      createdAt: "2026-10-09T00:00:00.000Z",
      width: 2,
      height: 1,
    };
    const broker = {
      ...base,
      invoke: <A>(input: PreviewAutomationInvokeInput) =>
        Effect.sync(() => {
          calls.push(input);
          return {
            url: "http://127.0.0.1:4791/",
            title: "Agent check",
            visibleText: "not sent to the agent",
            savedScreenshot: artifact,
            screenshot: { mimeType: "image/png", data: "iVBO", width: 2, height: 1 },
          } as A;
        }),
    };
    const result = await callPreviewTool(
      { broker, policy: ENABLED, threadId, automationSessionId: "s" },
      "preview_screenshot",
      {},
    );
    assert.equal(calls[0]?.operation, "snapshot");
    assert.deepEqual(calls[0]?.input, { save: true });
    assert.deepEqual(result.content[1], { type: "image", mimeType: "image/png", data: "iVBO" });
    assert.equal((result.structuredContent as { artifactId?: string }).artifactId, "preview-1");
    assert.equal(JSON.stringify(result.structuredContent).includes("not sent"), false);
  });

  it("rejects invalid input with Effect Schema even when zod would accept it", async () => {
    const { broker, calls } = recordingBroker();
    const result = await callPreviewTool(
      { broker, policy: ENABLED, threadId, automationSessionId: "s" },
      "preview_click",
      { selector: "#a", x: 1, y: 2 },
    );
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  });
});
