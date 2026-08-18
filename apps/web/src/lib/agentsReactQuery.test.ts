import { ProjectId, ProviderInstanceId, ThreadId, type AgentsSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { Project, Thread } from "../types";
import { decodeAgentsSnapshot, selectAgentActivityThreads } from "./agentsReactQuery";

describe("decodeAgentsSnapshot", () => {
  it("accepts an empty durable snapshot", () => {
    expect(
      decodeAgentsSnapshot({
        entries: [],
        generatedAt: "2026-08-15T10:00:00.000Z",
      }),
    ).toEqual({
      entries: [],
      generatedAt: "2026-08-15T10:00:00.000Z",
    });
  });

  it("rejects malformed or pre-upgrade RPC responses before model derivation", () => {
    expect(() => decodeAgentsSnapshot({})).toThrow();
    expect(() => decodeAgentsSnapshot({ entries: "not-an-array" })).toThrow();
  });
});

describe("selectAgentActivityThreads", () => {
  it("only selects threads represented by the bounded agents snapshot", () => {
    const relevantThreadId = ThreadId.makeUnsafe("thread-relevant");
    const unrelatedThreadId = ThreadId.makeUnsafe("thread-with-many-unrelated-activities");
    const projectId = ProjectId.makeUnsafe("project-agents");
    const snapshot: AgentsSnapshot = {
      generatedAt: "2026-08-18T10:00:00.000Z",
      entries: [
        {
          threadId: relevantThreadId,
          workItemId: "agent-1",
          provider: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionIdentity: "codex|default",
          turnId: null,
          classification: "working",
          ownership: "direct-subagent",
          status: "running",
          active: true,
          model: null,
          phase: null,
          latestOutput: null,
          outputTruncated: false,
          startedAt: "2026-08-18T09:59:00.000Z",
          updatedAt: "2026-08-18T10:00:00.000Z",
          lastSeenAt: "2026-08-18T10:00:00.000Z",
          completedAt: null,
        },
      ],
    };
    const threads = [
      {
        id: relevantThreadId,
        projectId,
        title: "Relevant",
        activities: [],
      },
      {
        id: unrelatedThreadId,
        projectId,
        title: "Unrelated",
        activities: Array.from({ length: 100_000 }, () => null),
      },
    ] as unknown as Thread[];
    const projects = [{ id: projectId, name: "F5" }] as unknown as Project[];

    expect(selectAgentActivityThreads({ snapshot, threads, projects })).toEqual([
      expect.objectContaining({
        threadId: relevantThreadId,
        threadTitle: "Relevant",
        projectName: "F5",
        activities: [],
      }),
    ]);
  });

  it("does no activity work before the snapshot is available", () => {
    expect(selectAgentActivityThreads({ snapshot: null, threads: [], projects: [] })).toEqual([]);
  });
});
