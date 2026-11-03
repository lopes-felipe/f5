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

export function readAgentTranscript(
  input: AgentsReadTranscriptInput,
  deps: {
    work: Pick<ThreadBackgroundWorkShape, "getOwnedEntries">;
    directory: Pick<ProviderSessionDirectoryShape, "getBinding">;
    service: Pick<ProviderServiceShape, "readChildThreadItems">;
    resolveAccount: (id: ProviderInstanceId) => Promise<{ environment: NodeJS.ProcessEnv }>;
    cwd?: string | undefined;
  },
) {
  return Effect.gen(function* () {
    const rows = yield* deps.work.getOwnedEntries(input);
    const provider = rows[0]?.provider;
    if (!provider || rows.some((row) => row.provider !== provider)) return unavailable("not-found");
    const row = rows.find((row) => row.kind !== "shell" && !row.workItemId.startsWith("toolu_"));
    if (!row) return unavailable("not-found");
    const expected = provider === "claudeAgent" ? "claude" : provider === "codex" ? "codex" : null;
    if (input.cursor && decodeCursor(input.cursor).p !== expected)
      throw new Error("Wrong provider cursor.");
    const { taskId } = readNativeTaskIdentity(row.workItemId);
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
