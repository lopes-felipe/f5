import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-11-05T12:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("pr-link-project");
const THREAD_ID = ThreadId.makeUnsafe("pr-link-thread");

let sequence = 0;
async function apply(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<OrchestrationReadModel> {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  let next = readModel;
  for (const event of Array.isArray(result) ? result : [result]) {
    sequence += 1;
    next = await Effect.runPromise(
      projectEvent(next, {
        ...event,
        sequence,
        eventId: EventId.makeUnsafe(`event-${sequence}`),
      } as OrchestrationEvent),
    );
  }
  return next;
}

const pr = (number: number) => ({
  provider: "github" as const,
  host: "github.com",
  repository: "o/r",
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
});

const meta = (
  id: string,
  fields: Partial<Extract<OrchestrationCommand, { type: "thread.meta.update" }>>,
): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.makeUnsafe(id),
  threadId: THREAD_ID,
  ...fields,
});

async function withThread() {
  let model = await apply(createEmptyReadModel(NOW), {
    type: "project.create",
    commandId: CommandId.makeUnsafe("project-create"),
    projectId: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/repo",
    createdAt: NOW,
  });
  model = await apply(model, {
    type: "thread.create",
    commandId: CommandId.makeUnsafe("thread-create"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    model: "gpt-5.5",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });
  return model;
}

const linksOf = (model: OrchestrationReadModel) =>
  model.threads.find((thread) => thread.id === THREAD_ID)?.pullRequests?.map((link) => link.number);

describe("thread pull request links", () => {
  it("keeps links newest first and removes an unlinked one", async () => {
    let model = await withThread();
    model = await apply(model, meta("link-1", { pullRequest: pr(1) }));
    model = await apply(model, meta("link-2", { pullRequest: pr(2) }));
    expect(linksOf(model)).toEqual([2, 1]);
    model = await apply(model, meta("unlink-2", { pullRequestUnlink: pr(2) }));
    expect(linksOf(model)).toEqual([1]);
  });

  it("rejects linking and unlinking in one command", async () => {
    const model = await withThread();
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: meta("both", { pullRequest: pr(1), pullRequestUnlink: pr(1) }),
          readModel: model,
        }),
      ),
    ).rejects.toThrow("cannot link and unlink");
  });
});
