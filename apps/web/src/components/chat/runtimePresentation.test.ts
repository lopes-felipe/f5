import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { recentRuntimeNotices, resolveRuntimeModelReport } from "./runtimePresentation";

function activity(
  id: string,
  kind: string,
  summary: string,
  payload: unknown,
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    kind,
    summary,
    payload,
    createdAt: "2026-10-10T00:00:00Z",
    tone: "info",
    turnId: null,
  };
}
describe("runtime presentation", () => {
  it("selects the latest model report by event order, including a configuration after reroute", () => {
    const configuration = activity("config", "runtime.configured", "Configured", {
      config: { model: "A" },
    });
    const reroute = activity("reroute", "runtime.model-rerouted", "Model rerouted", {
      fromModel: "A",
      toModel: "B",
      reason: "capacity",
    });
    expect(
      resolveRuntimeModelReport({
        configuredRuntime: { model: "A" },
        activities: [configuration, reroute],
      }),
    ).toMatchObject({ model: "B", reroute: { fromModel: "A" } });
    expect(
      resolveRuntimeModelReport({
        configuredRuntime: { model: "A" },
        activities: [reroute, configuration],
      }),
    ).toEqual({ model: "A", reroute: null });
  });
  it("keeps the newest four unique notices, headlines and details", () => {
    const notices = ["A", "B", "C", "D", "E", "A"].map((title, index) =>
      activity(String(index), "config.warning", title, { detail: `Path: /${title}` }),
    );
    expect(recentRuntimeNotices(notices).map((notice) => notice.title)).toEqual([
      "C",
      "D",
      "E",
      "A",
    ]);
    expect(recentRuntimeNotices(notices).at(-1)).toEqual({
      id: "5",
      title: "A",
      details: ["Path: /A"],
    });
    expect(
      recentRuntimeNotices([
        activity("guardian", "runtime.warning", "Guardian warning", {
          message: "Denied",
          detail: "Restricted path",
        }),
      ]),
    ).toEqual([
      { id: "guardian", title: "Guardian warning", details: ["Denied", "Restricted path"] },
    ]);
  });
  it("shows canonical MCP and reroute events and keeps distinct headlines with identical details", () => {
    const events = [
      activity("mcp", "mcp.status.updated", "MCP failed", { detail: "Unavailable" }),
      activity("reroute", "runtime.model-rerouted", "Model rerouted", { reason: "Capacity" }),
      activity("one", "config.warning", "First problem", { detail: "Path: /same" }),
      activity("two", "config.warning", "Second problem", { detail: "Path: /same" }),
    ];
    expect(recentRuntimeNotices(events).map((notice) => notice.title)).toEqual([
      "MCP failed",
      "Model rerouted",
      "First problem",
      "Second problem",
    ]);
  });
});
