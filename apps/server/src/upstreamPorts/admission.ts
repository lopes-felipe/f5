/**
 * Port admission helpers (plan §4.7): grouping, the idempotency hash, branch
 * names, titles and the exact `thread.turn.start` command each group submits.
 *
 * @module upstreamPorts/admission
 */
import {
  CommandId,
  isKnownProviderKind,
  MessageId,
  ProjectId,
  ThreadId,
  UPSTREAM_MAX_PORT_GROUPS,
  type ClientThreadTurnStartCommand,
  type ModelSelection,
  type RuntimeMode,
  type UpstreamStartPortInput,
  type UpstreamTopic,
} from "@t3tools/contracts";

import { canonicalJsonHash } from "../canonicalJsonHash.ts";

export const PORT_TITLE_MAX = 80;
export const PORT_SUBMISSION_PREFIX = "upstream-port:";

export class AdmissionError extends Error {
  constructor(
    readonly code: "conflict" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "UpstreamAdmissionError";
  }
}

export function portArgsHash(
  input: Pick<UpstreamStartPortInput, "topicIds" | "grouping" | "modelSelection" | "runtimeMode">,
): string {
  return canonicalJsonHash({
    topicIds: [...input.topicIds].toSorted(),
    grouping: input.grouping,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
  });
}

/** Topic id groups in request order; at most five per request. */
export function groupTopicIds(
  topicIds: ReadonlyArray<string>,
  grouping: "together" | "separately",
): string[][] {
  const unique = [...new Set(topicIds)];
  const groups = grouping === "together" ? [unique] : unique.map((id) => [id]);
  if (groups.length > UPSTREAM_MAX_PORT_GROUPS)
    throw new AdmissionError(
      "invalid",
      `Start at most ${UPSTREAM_MAX_PORT_GROUPS} separate ports at once, or port the topics together.`,
    );
  return groups;
}

export function portBranchName(topicIds: ReadonlyArray<string>): string {
  return topicIds.length === 1
    ? `f5/upstream-${topicIds[0]}`
    : `f5/upstream-${topicIds[0]}-and-${topicIds.length - 1}-more`;
}

export function portThreadTitle(topics: ReadonlyArray<Pick<UpstreamTopic, "title">>): string {
  if (topics.length !== 1) return `Port ${topics.length} upstream topics`;
  const title = `Port: ${topics[0]!.title}`;
  return title.length <= PORT_TITLE_MAX
    ? title
    : `${title.slice(0, PORT_TITLE_MAX - 1).trimEnd()}…`;
}

export const portSubmissionId = (clientRequestId: string, groupIndex: number) =>
  `${PORT_SUBMISSION_PREFIX}${clientRequestId}:${groupIndex}`;

export function buildPortCommand(input: {
  readonly projectId: string;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly submissionId: string;
  readonly title: string;
  readonly prompt: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly runSetupScript: boolean;
  readonly modelSelection: ModelSelection;
  readonly driver: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly createdAt: string;
}): ClientThreadTurnStartCommand {
  const model = input.modelSelection.model;
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(input.submissionId),
    threadId: ThreadId.makeUnsafe(input.threadId),
    message: {
      messageId: MessageId.makeUnsafe(input.messageId),
      role: "user",
      text: input.prompt,
      attachments: [],
    },
    ...(isKnownProviderKind(input.driver) ? { provider: input.driver } : {}),
    model,
    modelSelection: input.modelSelection,
    titleSourceText: input.title,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: ProjectId.makeUnsafe(input.projectId),
        title: input.title,
        model,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        branch: input.baseBranch,
        worktreePath: null,
        createdAt: input.createdAt,
      },
      prepareWorktree: {
        projectCwd: input.projectCwd,
        baseBranch: input.baseBranch,
        branch: input.branch,
      },
      ...(input.runSetupScript ? { runSetupScript: true } : {}),
    },
    createdAt: input.createdAt,
  };
}
