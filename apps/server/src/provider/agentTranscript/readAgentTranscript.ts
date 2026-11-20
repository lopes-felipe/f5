import { ProviderInstanceId, type AgentsReadTranscriptInput } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { readNativeTaskIdentity } from "@t3tools/shared/nativeTaskIdentity";
import type { ThreadBackgroundWorkShape } from "../../orchestration/Services/ThreadBackgroundWork.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { readClaudeResumeState } from "../claudeResumeState.ts";
import { readPersistedCwd } from "../runtimePayload.ts";
import { resolveClaudeConfigDir } from "../Drivers/ClaudeHome.ts";
import { readClaudeAgentTranscript, unavailable } from "./readClaudeAgentTranscript.ts";
import { readCodexAgentTranscript } from "./readCodexAgentTranscript.ts";
import { decodeCursor } from "./agentTranscriptCursor.ts";
import { backgroundWorkSessionIdentity } from "../backgroundWorkIdentity.ts";
import { antigravityProfileDirectory } from "../acp/AntigravityAcpSupport.ts";
import { readAntigravityChildWork } from "../acp/AntigravityChildWork.ts";
import { emptyTranscriptPage } from "./readClaudeAgentTranscript.ts";
import { fitTranscriptItems } from "./transcriptPageBudget.ts";
import type { AgentTranscriptItem } from "@t3tools/contracts";

export function readAgentTranscript(
  input: AgentsReadTranscriptInput,
  deps: {
    work: Pick<ThreadBackgroundWorkShape, "getOwnedEntries"> &
      Partial<Pick<ThreadBackgroundWorkShape, "getThreadSnapshot">>;
    directory: Pick<ProviderSessionDirectoryShape, "getBinding">;
    service: Pick<ProviderServiceShape, "readChildThreadItems">;
    resolveAccount: (id: ProviderInstanceId) => Promise<{ environment: NodeJS.ProcessEnv }>;
    cwd?: string | undefined;
    stateDir?: string | undefined;
  },
) {
  return Effect.gen(function* () {
    const rows = yield* deps.work.getOwnedEntries(input);
    const provider = rows[0]?.provider;
    if (!provider || rows.some((row) => row.provider !== provider)) return unavailable("not-found");
    const eligible = rows.filter(
      (row) => row.kind !== "shell" && !row.workItemId.startsWith("toolu_"),
    );
    // Grouped Codex entries also contain the collab call; only the subagent
    // row identifies the receiver thread owned by the parent session.
    const row =
      provider === "codex"
        ? eligible.find((row) => row.workItemId.startsWith("subagent:"))
        : eligible[0];
    if (!row) return unavailable("not-found");
    const expected = provider === "claudeAgent" ? "claude" : provider === "codex" ? "codex" : null;
    if (input.cursor && decodeCursor(input.cursor).p !== expected)
      throw new Error("Wrong provider cursor.");
    const { taskId } = readNativeTaskIdentity(row.workItemId);
    if (provider === "antigravity") {
      if (input.cursor) throw new Error("Antigravity transcripts do not use cursors.");
      if (!deps.stateDir || !row.providerInstanceId || !row.nativeParentSessionId)
        return unavailable("identity-unavailable");
      const snapshot = deps.work.getThreadSnapshot
        ? yield* deps.work.getThreadSnapshot(input.threadId)
        : undefined;
      const launchRow = snapshot?.entries.find((entry) => entry.workItemId === row.workItemId);
      const children = yield* readAntigravityChildWork({
        profileDirectory: antigravityProfileDirectory(deps.stateDir, row.providerInstanceId),
        rootSessionId: row.nativeParentSessionId,
        nativeTaskId: taskId,
        launch: { title: launchRow?.title ?? null, prompt: launchRow?.prompt ?? "" },
        siblings: (snapshot?.entries ?? [])
          .filter(
            (entry) =>
              entry.provider === "antigravity" &&
              entry.providerInstanceId === row.providerInstanceId &&
              entry.workItemId !== row.workItemId,
          )
          .map((entry) => ({
            nativeTaskId: readNativeTaskIdentity(entry.workItemId).taskId,
            title: entry.title,
            prompt: entry.prompt ?? "",
          })),
      });
      if (!children.length) return unavailable(row.active ? "not-started" : "not-found");
      const items: AgentTranscriptItem[] = children.flatMap((child) => [
        {
          id: child.conversationId + ":launch",
          createdAt: null,
          kind: "message" as const,
          role: "user" as const,
          text: child.role + "\n" + child.prompt,
          truncated: false,
        },
        ...(child.steps ?? []).flatMap((step): AgentTranscriptItem[] => {
          const id = child.conversationId + ":" + step.index;
          const tools: AgentTranscriptItem[] = step.toolCalls.map((tool, index) => ({
            id: id + ":tool:" + index,
            createdAt: null,
            kind: "tool-call",
            toolCallId: id + ":" + index,
            toolName: tool.name,
            itemType: "dynamic_tool_call",
            title: tool.name,
            detail: tool.input,
            status: "completed",
            output: "",
            outputTruncated: false,
          }));
          return [
            ...tools,
            ...(step.text
              ? [
                  {
                    id,
                    createdAt: null,
                    kind: "message" as const,
                    role: "assistant" as const,
                    text: step.text,
                    truncated: child.truncated,
                  },
                ]
              : []),
          ];
        }),
        ...(child.steps === null
          ? [
              {
                id: child.conversationId + ":missing",
                createdAt: null,
                kind: "notice" as const,
                text: "This child's transcript is not available yet.",
              },
            ]
          : []),
      ]);
      return { ...emptyTranscriptPage(), items: fitTranscriptItems(items.slice(-500)) };
    }
    if (provider === "codex") {
      if (!deps.service.readChildThreadItems) return unavailable("unsupported-provider");
      return yield* readCodexAgentTranscript(input, (cursor) =>
        deps.service.readChildThreadItems!({
          threadId: input.threadId,
          childId: taskId,
          providerInstanceId: row.providerInstanceId,
          cursor,
          limit: Math.min(50, input.limit ?? 200),
        }),
      );
    }
    if (provider !== "claudeAgent") return unavailable("unsupported-provider");
    const option = yield* deps.directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(option);
    const matches =
      binding?.provider === "claudeAgent" &&
      (binding.providerInstanceId ?? null) === row.providerInstanceId;
    const sessionId =
      row.nativeParentSessionId ??
      // Instance equality alone is insufficient after restarting the same account.
      (matches && row.providerSessionIdentity === backgroundWorkSessionIdentity(binding!)
        ? readClaudeResumeState(binding?.resumeCursor)?.resume
        : undefined);
    if (!sessionId) return unavailable("identity-unavailable");
    const account = yield* Effect.tryPromise(() =>
      deps.resolveAccount(row.providerInstanceId ?? ProviderInstanceId.makeUnsafe("claudeAgent")),
    );
    const cwd = (matches ? readPersistedCwd(binding?.runtimePayload) : undefined) ?? deps.cwd;
    return yield* Effect.tryPromise((signal) =>
      readClaudeAgentTranscript(
        input,
        {
          configDir: resolveClaudeConfigDir(account.environment, cwd),
          sessionId,
          agentId: taskId,
          active: row.active,
        },
        signal,
      ),
    );
  });
}
