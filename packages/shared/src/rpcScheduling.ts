export type RpcLane = "ordinary" | "stop" | "answer" | "recovery";

/** Inspect the decoded command as well as its transport method. */
export function rpcLane(body: { readonly _tag: string; readonly command?: unknown }): RpcLane {
  const command =
    body.command && typeof body.command === "object" && "type" in body.command
      ? String(body.command.type)
      : "";
  if (
    body._tag === "storage.cancelCleanup" ||
    command === "thread.turn.interrupt" ||
    command === "thread.session.stop" ||
    /(?:cancel|interrupt|stopSession|revoke)$/i.test(body._tag)
  )
    return "stop";
  if (
    command === "thread.approval.respond" ||
    command === "thread.user-input.respond" ||
    command === "thread.turn.steer" ||
    body._tag === "nextTurnQueue.steer" ||
    /(?:respondToRequest|respondToUserInput|respondToElicitation|elicitation.submit|automation.respond)$/i.test(
      body._tag,
    )
  )
    return "answer";
  if (
    /^orchestration\.(?:getStartupSnapshot|getSnapshot|getLatestSequence|replayEvents)$/.test(
      body._tag,
    ) ||
    body._tag === "terminal.snapshot" ||
    body._tag === "server.probe" ||
    body._tag === "storage.getStatus"
  )
    return "recovery";
  return "ordinary";
}

export const RPC_LANE_LIMITS: Readonly<Record<RpcLane, number>> = {
  ordinary: 8,
  stop: 1,
  answer: 2,
  recovery: 1,
};
export const RPC_ORDINARY_BYTES = 80 * 1024 * 1024;

/** No waiting queue: reject overload before executing or retaining its payload. */
export class RpcAdmission {
  private readonly counts: Record<RpcLane, number> = {
    ordinary: 0,
    stop: 0,
    answer: 0,
    recovery: 0,
  };
  private readonly bytes: Record<RpcLane, number> = {
    ordinary: 0,
    stop: 0,
    answer: 0,
    recovery: 0,
  };
  claim(lane: RpcLane, bytes: number): (() => void) | null {
    const budget = lane === "ordinary" ? RPC_ORDINARY_BYTES : 40 * 1024 * 1024;
    if (this.counts[lane] >= RPC_LANE_LIMITS[lane] || this.bytes[lane] + bytes > budget)
      return null;
    this.counts[lane]++;
    this.bytes[lane] += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.counts[lane]--;
      this.bytes[lane] -= bytes;
    };
  }
}

const READ_ONLY_METHODS = new Set([
  "threads.search",
  "storage.getUsage",
  "storage.getStatus",
  "storage.getOperation",
  "storage.getTargets",
  "agentBridge.getState",
  "agentBridge.getTask",
  "agentBridge.getTaskActivities",
  "agentBridge.getTasks",
  "agents.getSnapshot",
  "attachments.getUploads",
  "chrome.listNativeHostTransactions",
  "computer.access.list",
  "computer.access.listRemembered",
  "filesystem.browse",
  "git.listBranches",
  "git.status",
  "githubAccount.cliCandidates",
  "githubAccount.loginStatus",
  "githubAccount.status",
  "globalSearch.query",
  "mcp.getCodexStatus",
  "mcp.getCommonConfig",
  "mcp.getEffectiveConfig",
  "mcp.getLoginStatus",
  "mcp.getOAuthStatus",
  "mcp.getProjectConfig",
  "mcp.getProviderStatus",
  "mcp.getServerStatuses",
  "mcp.inspectServer",
  "mcp.listImportCandidates",
  "nativeOperation.inspect",
  "nativeOperation.list",
  "nextTurnQueue.list",
  "nextTurnQueue.summary",
  "orchestration.getFullThreadDiff",
  "orchestration.getRewindDrafts",
  "orchestration.getSnapshot",
  "orchestration.getLatestSequence",
  "orchestration.getStartupSnapshot",
  "orchestration.getThreadCommandExecution",
  "orchestration.getThreadCommandExecutions",
  "orchestration.getThreadDetails",
  "orchestration.getThreadFileChange",
  "orchestration.getThreadFileChanges",
  "orchestration.getThreadHistoryPage",
  "orchestration.getThreadTailDetails",
  "orchestration.getTurnDiff",
  "prHub.getAdvisories",
  "prHub.getCommentOperation",
  "prHub.getDetail",
  "prHub.getFiles",
  "prHub.getOperation",
  "prHub.getOverview",
  "prHub.getReplyDraft",
  "prHub.getReplyOperation",
  "prHub.getReviewDraft",
  "prHub.getReviewOperation",
  "prHub.getReviewThreads",
  "prHub.getStack",
  "prHub.getThreadLinks",
  "prHub.getThreadsForPr",
  "prHub.getTimeline",
  "prHub.getUnresolvedThreads",
  "prHub.getViewedFiles",
  "prHub.listAccountRouting",
  "prHub.listAccounts",
  "prHub.listLocalCheckoutCandidates",
  "prHub.listPullRequests",
  "prHub.listReviewerCandidates",
  "prHub.peek",
  "preview.list",
  "preview.listLocalServers",
  "profiles.list",
  "projects.cloneList",
  "projects.getCheckedInConfig",
  "projects.list",
  "projects.listDirectory",
  "projects.listEntries",
  "projects.readFile",
  "projects.searchContents",
  "projects.searchEntries",
  // Idempotent and workspace-read-only: replaces this client's watch set, and
  // must be resendable right after a reconnect, before resynchronization.
  "projects.setWatchedPaths",
  "providerAccount.status",
  "review.previewDiff",
  "server.getClaudeTranscriptRepair",
  "server.getConfig",
  "server.getProjectSettings",
  "server.getProviderInventory",
  "server.probe",
  "storage.getDiskSpace",
  "storage.getUsage",
  "terminal.snapshot",
  "usage.getAccounts",
  "usage.getSummary",
  "worktrees.list",
  "workflowPlatform.inspectRun",
  "workflowPlatform.listTemplates",
]);

/** Connectivity admission only. Unknown methods require reconciliation. */
export function isReadOnlyRpc(method: string): boolean {
  return READ_ONLY_METHODS.has(method);
}
