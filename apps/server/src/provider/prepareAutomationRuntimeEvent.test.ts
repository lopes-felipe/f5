import { runtimeEventToActivities } from "../orchestration/Layers/ProviderRuntimeIngestion";
import { EventId, RuntimeItemId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { automationEventSanitizer } from "@t3tools/shared/automationActivitySanitizer";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  carryPreparedComputerEvidence,
  createAutomationRuntimeEventPreparer,
} from "./prepareAutomationRuntimeEvent";
import { compactThreadActivityPayload } from "@t3tools/shared/orchestrationActivityPayload";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const threadId = ThreadId.makeUnsafe("computer-image-admission");
afterEach(() => automationEventSanitizer.clear(threadId));
describe("computer event queue admission", () => {
  it.each(["claudeAgent", "codex"] as const)(
    "stores %s images before cleaning and retains references after disposal",
    async (provider) => {
      automationEventSanitizer.register(threadId, {
        serverName: "f5_computer",
        verified: true,
        kind: "f5-computer",
      });
      const image =
        provider === "claudeAgent"
          ? { type: "image", source: { type: "base64", media_type: "image/png", data: png } }
          : { type: "image", mimeType: "image/png", data: png };
      const event: ProviderRuntimeEvent = {
        type: "item.completed",
        eventId: EventId.makeUnsafe("computer-image-event"),
        threadId,
        itemId: RuntimeItemId.makeUnsafe("computer-image-item"),
        provider,
        createdAt: new Date().toISOString(),
        payload: {
          itemType: "mcp_tool_call",
          data: {
            toolName: "mcp__f5_computer__computer_screenshot",
            input: { text: "PRIVATE_TYPED_SENTINEL" },
            result: { content: [image, { type: "text", text: "PRIVATE_RESULT_SENTINEL" }] },
          },
        },
      };
      const store = vi.fn((_event, bytes) => {
        expect(Buffer.from(bytes.bytes).toString("base64")).toBe(png);
        return Effect.succeed({
          attachmentId: "saved-computer-image",
          mimeType: "image/png",
          sizeBytes: bytes.bytes.length,
        });
      });
      const queued = await Effect.runPromise(createAutomationRuntimeEventPreparer(store)(event));
      expect(store).toHaveBeenCalledOnce();
      if (queued.type !== "item.completed") throw new Error("Unexpected event type");
      expect(queued.payload.mcpImages).toEqual([
        expect.objectContaining({ attachmentId: "saved-computer-image" }),
      ]);
      const serialized = JSON.stringify(queued);
      expect(serialized).not.toContain(png);
      expect(serialized).not.toContain("PRIVATE_");
      const logged = automationEventSanitizer.sanitize(threadId, queued) as typeof queued;
      expect(logged.payload.mcpImages).toEqual(queued.payload.mcpImages);
      // The actual timeline consumes the twice-sanitized data envelope. Tool
      // identity and safe summaries must survive without reintroducing raw IO.
      const activity = compactThreadActivityPayload({
        kind: "tool.completed",
        payload: logged.payload,
      });
      expect(queued.payload.computerTool).toBe(true);
      expect(activity).toMatchObject({
        computerTool: true,
        mcpServerName: "f5_computer",
        mcpToolName: "computer_screenshot",
      });
      expect(activity.mcpInput).toContain("sanitized");
      expect(activity.mcpResult).toContain("sanitized");
      expect(JSON.stringify(activity)).not.toContain("PRIVATE_");
      automationEventSanitizer.clear(threadId);
      expect(automationEventSanitizer.sanitize(threadId, queued)).toEqual(queued);
      const canonical = { ...queued };
      carryPreparedComputerEvidence(queued, canonical);
      expect(
        runtimeEventToActivities(canonical).some(
          (entry) => (entry.payload as Record<string, unknown>).computerTool === true,
        ),
      ).toBe(true);

      expect(
        runtimeEventToActivities(queued).some(
          (entry) => (entry.payload as Record<string, unknown>).computerTool === true,
        ),
      ).toBe(true);
      expect(JSON.stringify(event)).toContain(png); // Model-facing input was not changed.
    },
  );
  it("counts refused storage and excess images without putting bytes in the queue", async () => {
    automationEventSanitizer.register(threadId, {
      serverName: "f5_computer",
      verified: true,
      kind: "f5-computer",
    });
    const event: ProviderRuntimeEvent = {
      type: "item.completed",
      eventId: EventId.makeUnsafe("omitted"),
      threadId,
      itemId: RuntimeItemId.makeUnsafe("omitted"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      payload: {
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__f5_computer__computer_screenshot",
          result: {
            content: [
              { type: "image", mimeType: "image/png", data: png },
              { type: "image", mimeType: "image/png", data: png },
            ],
          },
        },
      },
    };
    const queued = await Effect.runPromise(
      createAutomationRuntimeEventPreparer(() => Effect.succeed(null))(event),
    );
    if (queued.type !== "item.completed") throw new Error("Unexpected event type");
    expect(queued.payload.mcpImagesOmitted).toBe(2);
    expect(queued.payload.mcpImages).toBeUndefined();
    expect(JSON.stringify(queued)).not.toContain(png);
    expect(JSON.stringify(automationEventSanitizer.sanitize(threadId, queued))).toContain(
      '"mcpImagesOmitted":2',
    );
  });
  it.each([
    [
      "computer_key",
      { keys: ["Meta+L"], repeat: 2 },
      { appName: "Google Chrome", keyChord: "Meta+L", repeat: 2 },
    ],
    [
      "computer_type",
      { text: "PRIVATE_TYPED_SENTINEL" },
      { appName: "Google Chrome", typedLength: 22 },
    ],
  ])("summarizes %s without its raw input", async (tool, input, expected) => {
    automationEventSanitizer.register(threadId, {
      serverName: "f5_computer",
      verified: true,
      kind: "f5-computer",
    });
    const structuredContent = { appName: "Google Chrome" };
    const event: ProviderRuntimeEvent = {
      type: "item.completed",
      eventId: EventId.makeUnsafe(`step-${tool}`),
      threadId,
      itemId: RuntimeItemId.makeUnsafe(`step-${tool}`),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      payload: {
        itemType: "mcp_tool_call",
        computerStep: { keyChord: "Escape" },
        data: {
          toolName: `mcp__f5_computer__${tool}`,
          input,
          result: {
            structuredContent,
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          },
        },
      },
    };
    const queued = await Effect.runPromise(
      createAutomationRuntimeEventPreparer(() => Effect.succeed(null))(event),
    );
    if (queued.type !== "item.completed") throw new Error("Unexpected event type");
    expect(queued.payload.computerStep).toEqual(expected);
    const logged = automationEventSanitizer.sanitize(threadId, queued) as typeof queued;
    const activity = compactThreadActivityPayload({
      kind: "tool.completed",
      payload: logged.payload,
    });
    expect(activity).toMatchObject({ computerTool: true, computerStep: expected });
    expect(JSON.stringify(logged)).not.toContain("PRIVATE_");
    expect(JSON.stringify(activity)).not.toContain("PRIVATE_");
    expect(
      runtimeEventToActivities(queued).some(
        (entry) =>
          JSON.stringify((entry.payload as Record<string, unknown>).computerStep) ===
          JSON.stringify(expected),
      ),
    ).toBe(true);
  });
  it("does not treat look-alike project servers as F5 computer tools", async () => {
    automationEventSanitizer.register(threadId, {
      serverName: "f5_computer",
      verified: true,
      kind: "f5-computer",
    });
    const event: ProviderRuntimeEvent = {
      type: "item.completed",
      eventId: EventId.makeUnsafe("lookalike"),
      threadId,
      provider: "codex",
      createdAt: new Date().toISOString(),
      payload: {
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__f5_computer_other__computer_screenshot",
          result: { content: [{ type: "image", mimeType: "image/png", data: png }] },
        },
      },
    };
    const store = vi.fn(() => Effect.succeed(null));
    expect(await Effect.runPromise(createAutomationRuntimeEventPreparer(store)(event))).toEqual(
      event,
    );
    expect(store).not.toHaveBeenCalled();
  });
});

it("ignores a third-party computer tool name and a provider-supplied computer marker", async () => {
  const event: ProviderRuntimeEvent = {
    type: "item.completed",
    eventId: EventId.makeUnsafe("lookalike"),
    threadId,
    itemId: RuntimeItemId.makeUnsafe("lookalike"),
    provider: "codex",
    createdAt: new Date().toISOString(),
    payload: {
      itemType: "mcp_tool_call",
      computerTool: true,
      computerStep: { keyChord: "Enter" },
      data: { toolName: "mcp__third_party__computer_click", status: "completed" },
    },
  };
  const queued = await Effect.runPromise(
    createAutomationRuntimeEventPreparer(() => Effect.succeed(null))(event),
  );
  if (queued.type !== "item.completed") throw new Error("Unexpected event");
  expect(queued.payload.computerTool).toBeUndefined();
  expect(queued.payload.computerStep).toBeUndefined();
  expect(
    runtimeEventToActivities(event).every(
      (entry) => !(entry.payload as Record<string, unknown>)?.computerTool,
    ),
  ).toBe(true);
  expect(
    runtimeEventToActivities(queued).every(
      (entry) => !(entry.payload as Record<string, unknown>)?.computerTool,
    ),
  ).toBe(true);
});
