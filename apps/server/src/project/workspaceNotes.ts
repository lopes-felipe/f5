import { CommandId, EventId, type ThreadId } from "@t3tools/contracts";
import { timeOrderedUuid } from "@t3tools/shared/ids";
import { Effect } from "effect";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";

/** The thread's folder moved to another branch. */
export const WORKSPACE_BRANCH_CHANGED_ACTIVITY_KIND = "workspace.branch-changed";
/** Anything else F5 did to, or could not do to, a thread's workspace on its own. */
export const WORKSPACE_NOTE_ACTIVITY_KIND = "workspace.note";

export interface WorkspaceNote {
  readonly kind?: string;
  readonly summary: string;
  /** "error" when the user asked for something that did not happen or left files behind. */
  readonly tone?: "info" | "error";
  readonly payload?: Record<string, unknown>;
}

/**
 * Reports in the thread's timeline what happened to its workspace without the
 * user asking, so nothing has to be held open for them to acknowledge. Best
 * effort: a thread archived or deleted meanwhile does not get the note.
 */
export const appendWorkspaceNote = (
  engine: Pick<OrchestrationEngineShape, "dispatch">,
  threadId: ThreadId,
  note: WorkspaceNote,
) => {
  const createdAt = new Date().toISOString();
  return engine
    .dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(`server:workspace-note:${timeOrderedUuid()}`),
      threadId,
      activity: {
        id: EventId.makeUnsafe(`workspace-note:${timeOrderedUuid()}`),
        kind: note.kind ?? WORKSPACE_NOTE_ACTIVITY_KIND,
        tone: note.tone ?? "info",
        summary: note.summary,
        payload: note.payload ?? {},
        turnId: null,
        createdAt,
      },
      createdAt,
    })
    .pipe(Effect.ignore);
};
