import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { createPersistentOrchestrationSystem } from "./testUtils/persistentOrchestration.ts";
const now = () => new Date().toISOString();
const asMessageId = MessageId.makeUnsafe;
const asProjectId = ProjectId.makeUnsafe;

it("releases deleted thread details across restart while preserving stored decisions and projections", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-deleted-details-"));
  const dbPath = path.join(directory, "state.sqlite");
  let system = await createPersistentOrchestrationSystem({ dbPath });
  const threadId = ThreadId.makeUnsafe("deleted-history");
  const activeId = ThreadId.makeUnsafe("active-history");
  const messageId = asMessageId("retained-assistant");
  const projectId = asProjectId("retained-project");
  const createdAt = now();
  try {
    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("retain-project"),
        projectId,
        title: "Project",
        workspaceRoot: directory,
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    for (const id of [threadId, activeId]) {
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(`create-${id}`),
          threadId: id,
          projectId,
          title: id,
          model: "gpt-5-codex",
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe(`delta-${id}`),
          threadId: id,
          messageId: id === threadId ? messageId : asMessageId("active-assistant"),
          delta: "retained prefix",
          reasoningDelta: "reasoning",
          createdAt,
        }),
      );
    }
    await system.run(
      system.engine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.makeUnsafe("retain-plan"),
        threadId,
        proposedPlan: {
          id: "plan",
          turnId: null,
          planMarkdown: "# Plan",
          implementedAt: null,
          implementationThreadId: null,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("retain-activity"),
        threadId,
        activity: {
          id: EventId.makeUnsafe("activity"),
          tone: "info",
          kind: "runtime.note",
          summary: "Retained activity",
          payload: {},
          turnId: null,
          createdAt,
        },
        createdAt,
      }),
    );
    const before = (await system.run(system.engine.getReadModel())).threads.find(
      (t) => t.id === threadId,
    )!;
    await system.run(
      system.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("retain-delete"),
        threadId,
      }),
    );
    const deleted = (await system.run(system.engine.getReadModel())).threads.find(
      (t) => t.id === threadId,
    )!;
    expect(deleted).toMatchObject({
      messages: [],
      activities: [],
      proposedPlans: [],
      estimatedContextTokens: before.estimatedContextTokens,
    });
    expect(deleted.deletedAt).not.toBeNull();
    await system.dispose();
    system = await createPersistentOrchestrationSystem({ dbPath });
    const bootstrap = await system.run(system.snapshotQuery.getBootstrapSnapshot());
    expect(bootstrap.threads.find((t) => t.id === threadId)).toMatchObject({
      messages: [],
      activities: [],
      proposedPlans: [],
    });
    expect(bootstrap.threads.find((t) => t.id === activeId)?.messages).toHaveLength(1);
    const details = await system.run(system.snapshotQuery.getRetainedThreadDetails!(threadId));
    expect(details.messages).toEqual(before.messages);
    expect(details.proposedPlans).toEqual(before.proposedPlans);
    expect(details.activities).toEqual(before.activities);
    await system.run(
      system.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.makeUnsafe("post-delete-delta"),
        threadId,
        messageId,
        delta: " suffix",
        createdAt,
      }),
    );
    expect(
      (await system.run(system.engine.getReadModel())).threads.find((t) => t.id === threadId)
        ?.messages,
    ).toEqual([]);
    const appended = await system.run(system.snapshotQuery.getRetainedThreadDetails!(threadId));
    expect(appended.messages[0]?.text).toBe("retained prefix suffix");
    expect(appended.messages[0]?.reasoningText).toBe("reasoning");
    await system.run(
      system.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("post-delete-complete"),
        threadId,
        messageId,
        createdAt,
      }),
    );
    const completed = await system.run(system.engine.getReadModel());
    await system.run(
      system.engine
        .dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe("late-post-delete-delta"),
          threadId,
          messageId,
          delta: " duplicate",
          createdAt,
        })
        .pipe(Effect.flip),
    );
    expect((await system.run(system.engine.getReadModel())).snapshotSequence).toBe(
      completed.snapshotSequence,
    );
    expect(
      (await system.run(system.snapshotQuery.getRetainedThreadDetails!(threadId))).messages[0]
        ?.text,
    ).toBe("retained prefix suffix");
  } finally {
    await system.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
