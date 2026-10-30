import type { ClientOrchestrationCommand, WebSocketRequest } from "@t3tools/contracts";
import { CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS } from "./codexOAuthTiming";

export type RpcLane = "ordinary" | "stop" | "answer" | "recovery" | "long" | "health";
export const RPC_LANES: ReadonlyArray<RpcLane> = [
  "ordinary",
  "stop",
  "answer",
  "recovery",
  "long",
  "health",
];

/** Every `_tag` the server routes. Type-only, so the web bundle never pulls in request schemas. */
export type WsRequestTag = WebSocketRequest["body"]["_tag"];

export interface RpcMethodPolicy {
  /**
   * `read` methods are retried on `RpcBusy` and may be sent before synchronization.
   * `connection-control` methods are idempotent and resendable before synchronization.
   * Anything not proven read-only is a `mutation`: never retried, replayed or sent before sync.
   */
  readonly kind: "read" | "mutation" | "connection-control";
  readonly lane: RpcLane;
  /** The route waits for the orchestration runtime, directly or through a helper. */
  readonly requiresRuntime: boolean;
  /** Lane `long` only: the client's execution deadline. `null` means no deadline. */
  readonly longRunningTimeoutMs?: number | null;
}

const READ: RpcMethodPolicy = { kind: "read", lane: "ordinary", requiresRuntime: false };
const READ_RT: RpcMethodPolicy = { ...READ, requiresRuntime: true };
const MUTATION: RpcMethodPolicy = { kind: "mutation", lane: "ordinary", requiresRuntime: false };
const MUTATION_RT: RpcMethodPolicy = { ...MUTATION, requiresRuntime: true };
const STOP: RpcMethodPolicy = { kind: "mutation", lane: "stop", requiresRuntime: false };
const STOP_RT: RpcMethodPolicy = { ...STOP, requiresRuntime: true };
const ANSWER: RpcMethodPolicy = { kind: "mutation", lane: "answer", requiresRuntime: false };
const ANSWER_RT: RpcMethodPolicy = { ...ANSWER, requiresRuntime: true };
const RECOVERY_READ: RpcMethodPolicy = { kind: "read", lane: "recovery", requiresRuntime: false };
const RECOVERY_READ_RT: RpcMethodPolicy = { ...RECOVERY_READ, requiresRuntime: true };
const HEALTH: RpcMethodPolicy = { kind: "read", lane: "health", requiresRuntime: false };
const CONNECTION_CONTROL: RpcMethodPolicy = {
  kind: "connection-control",
  lane: "ordinary",
  requiresRuntime: false,
};
const long = (requiresRuntime: boolean, longRunningTimeoutMs: number | null): RpcMethodPolicy => ({
  kind: "mutation",
  lane: "long",
  requiresRuntime,
  longRunningTimeoutMs,
});

/**
 * One policy per routed method; the compiler rejects a missing or unknown tag.
 *
 * `requiresRuntime` follows the route: `true` when it awaits the orchestration
 * runtime unconditionally. Routes that wait only on some bodies stay `false`
 * here and are listed in `BODY_RUNTIME_DEPENDENCIES`. Every Upstream route
 * resolves its project through the engine read model.
 *
 * Upstream reads were audited to write nothing and never fetch:
 * `getPortQueue` can start a base fetch, so it stays a mutation.
 */
export const RPC_METHOD_POLICY = {
  "agentBridge.cancelTask": MUTATION,
  "agentBridge.createTask": MUTATION_RT,
  "agentBridge.getState": READ,
  "agentBridge.getTask": READ,
  "agentBridge.getTaskActivities": READ,
  "agentBridge.getTasks": READ,
  "agentBridge.pauseTask": MUTATION,
  "agentBridge.replyToTask": MUTATION,
  "agentBridge.resumeTask": MUTATION_RT,
  "agentBridge.setSchedulingGrant": MUTATION,

  "agents.dismiss": MUTATION_RT,
  "agents.getSnapshot": READ_RT,

  "attachments.cloneToUpload": MUTATION,
  "attachments.getUploads": READ,
  "attachments.releaseUploads": MUTATION,

  "chrome.getReadiness": MUTATION,
  "chrome.listNativeHostTransactions": READ,

  "claudeChrome.restoreNativeHost": MUTATION,

  "codexChrome.restoreNativeHost": MUTATION,

  "computer.access.forgetRemembered": MUTATION,
  "computer.access.list": READ,
  "computer.access.listRemembered": READ,
  "computer.access.revoke": STOP,

  "elicitation.submit": ANSWER_RT,

  "filesystem.browse": READ,

  "git.checkout": MUTATION_RT,
  "git.createBranch": MUTATION,
  "git.createWorktree": MUTATION_RT,
  "git.init": MUTATION,
  "git.listBranches": READ,
  "git.preparePullRequestThread": MUTATION,
  "git.prepareWorktree": long(true, null),
  "git.pull": MUTATION,
  "git.removeWorktree": MUTATION_RT,
  "git.resolvePullRequest": MUTATION,
  "git.runStackedAction": long(false, null),
  "git.status": READ,

  "githubAccount.cliCandidates": READ,
  "githubAccount.cliImport": MUTATION,
  "githubAccount.loginCancel": STOP,
  "githubAccount.loginStart": MUTATION,
  "githubAccount.loginStatus": READ,
  "githubAccount.remove": MUTATION,
  "githubAccount.set": MUTATION,
  "githubAccount.status": READ,

  "globalSearch.query": READ,

  "htmlRender.host": MUTATION,
  "htmlRender.respond": MUTATION,

  "mcp.applyToLiveSessions": MUTATION_RT,
  "mcp.getCodexStatus": READ,
  "mcp.getCommonConfig": READ,
  "mcp.getEffectiveConfig": READ,
  "mcp.getLoginStatus": READ,
  "mcp.getOAuthStatus": READ,
  "mcp.getProjectConfig": READ,
  "mcp.getProviderStatus": READ,
  "mcp.getServerStatuses": READ,
  "mcp.inspectServer": READ,
  "mcp.listImportCandidates": READ,
  "mcp.probeServer": long(false, 75_000),
  "mcp.reconnectServer": MUTATION_RT,
  "mcp.reloadProject": MUTATION,
  "mcp.replaceCommonConfig": MUTATION,
  "mcp.replaceProjectConfig": MUTATION,
  "mcp.startLogin": long(false, CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS),
  "mcp.startOAuthLogin": long(false, CODEX_MCP_OAUTH_LOGIN_REQUEST_TIMEOUT_MS),
  "mcp.storeSecret": MUTATION,

  "mcpApps.callTool": MUTATION_RT,
  "mcpApps.readResource": MUTATION_RT,
  "mcpApps.toolInfo": MUTATION_RT,
  "mcpApps.updateModelContext": MUTATION_RT,

  "nativeOperation.execute": MUTATION_RT,
  "nativeOperation.fork": MUTATION_RT,
  "nativeOperation.historyRecovery": MUTATION_RT,
  "nativeOperation.inspect": READ_RT,
  "nativeOperation.list": READ_RT,
  "nativeOperation.resolve": MUTATION_RT,

  "nextTurnQueue.cancel": STOP_RT,
  "nextTurnQueue.cancelUsageLimitResume": MUTATION_RT,
  "nextTurnQueue.clear": MUTATION_RT,
  "nextTurnQueue.discardDelivery": MUTATION_RT,
  "nextTurnQueue.duplicate": MUTATION_RT,
  "nextTurnQueue.list": READ,
  "nextTurnQueue.promote": MUTATION_RT,
  "nextTurnQueue.recheckDelivery": MUTATION_RT,
  "nextTurnQueue.refreshGate": MUTATION_RT,
  "nextTurnQueue.refreshUsageLimitResume": MUTATION_RT,
  "nextTurnQueue.reorder": MUTATION_RT,
  "nextTurnQueue.restore": MUTATION_RT,
  "nextTurnQueue.retry": MUTATION_RT,
  "nextTurnQueue.retryDelivery": MUTATION_RT,
  "nextTurnQueue.scheduleUsageLimitResume": MUTATION_RT,
  "nextTurnQueue.setPaused": MUTATION_RT,
  "nextTurnQueue.steer": ANSWER_RT,
  "nextTurnQueue.submit": MUTATION_RT,
  "nextTurnQueue.summary": READ,
  "nextTurnQueue.update": MUTATION_RT,

  "orchestration.archiveCodeReviewWorkflow": MUTATION_RT,
  "orchestration.archiveInvestigationWorkflow": MUTATION_RT,
  "orchestration.archiveWorkflow": MUTATION_RT,
  "orchestration.createCodeReviewWorkflow": MUTATION_RT,
  "orchestration.createInvestigationWorkflow": MUTATION_RT,
  "orchestration.createWorkflow": MUTATION_RT,
  "orchestration.deleteCodeReviewWorkflow": MUTATION_RT,
  "orchestration.deleteInvestigationWorkflow": MUTATION_RT,
  "orchestration.deleteWorkflow": MUTATION_RT,
  "orchestration.dispatchCommand": MUTATION_RT,
  "orchestration.getFullThreadDiff": READ,
  "orchestration.getLatestSequence": RECOVERY_READ_RT,
  "orchestration.getRewindDrafts": READ,
  "orchestration.getSnapshot": RECOVERY_READ_RT,
  "orchestration.getStartupSnapshot": RECOVERY_READ,
  "orchestration.getThreadCommandExecution": READ,
  "orchestration.getThreadCommandExecutions": READ,
  "orchestration.getThreadDetails": READ,
  "orchestration.getThreadFileChange": READ,
  "orchestration.getThreadFileChanges": READ,
  "orchestration.getThreadHistoryPage": READ,
  "orchestration.getThreadTailDetails": READ,
  "orchestration.getTurnDiff": READ,
  "orchestration.retryCodeReviewWorkflow": MUTATION_RT,
  "orchestration.retryInvestigationWorkflow": MUTATION_RT,
  "orchestration.retryWorkflow": MUTATION_RT,
  "orchestration.skipDocumentReaderPass": MUTATION_RT,
  "orchestration.startImplementation": MUTATION_RT,
  "orchestration.unarchiveCodeReviewWorkflow": MUTATION_RT,
  "orchestration.unarchiveInvestigationWorkflow": MUTATION_RT,
  "orchestration.unarchiveWorkflow": MUTATION_RT,

  "preview.automation.clearOwner": MUTATION,
  "preview.automation.reportOwner": MUTATION,
  "preview.automation.respond": ANSWER,
  "preview.automation.setPaused": MUTATION,
  "preview.close": MUTATION,
  "preview.list": READ,
  "preview.listLocalServers": READ,
  "preview.navigate": MUTATION,
  "preview.open": MUTATION,
  "preview.refresh": MUTATION,
  "preview.reportRecordingMetrics": MUTATION,
  "preview.reportStatus": MUTATION,

  "prHub.acknowledgeAttention": MUTATION,
  "prHub.acknowledgeNotifications": MUTATION,
  "prHub.analyzeAdvisories": long(false, null),
  "prHub.approve": MUTATION,
  "prHub.cancelOperation": MUTATION,
  "prHub.cancelReviewPreparation": MUTATION,
  "prHub.changeReviewers": MUTATION,
  "prHub.claimNotifications": MUTATION,
  "prHub.clearData": MUTATION,
  "prHub.comment": MUTATION,
  "prHub.generateReviewGuide": MUTATION,
  "prHub.getAdvisories": READ,
  "prHub.getCommentOperation": READ,
  "prHub.getDetail": READ,
  "prHub.getFiles": READ,
  "prHub.getOperation": READ,
  "prHub.getOverview": READ,
  "prHub.getReplyDraft": READ,
  "prHub.getReplyOperation": READ,
  "prHub.getReviewDraft": READ,
  "prHub.getReviewGuide": MUTATION,
  "prHub.getReviewOperation": READ,
  "prHub.getReviewThreads": READ,
  "prHub.getStack": READ,
  "prHub.getThreadLinks": READ,
  "prHub.getThreadsForPr": READ,
  "prHub.getTimeline": READ,
  "prHub.getUnresolvedThreads": READ,
  "prHub.getViewedFiles": READ,
  "prHub.ignore": MUTATION,
  "prHub.listAccountRouting": READ,
  "prHub.listAccounts": READ,
  "prHub.listLocalCheckoutCandidates": READ,
  "prHub.listPullRequests": READ,
  "prHub.listReviewerCandidates": READ,
  "prHub.markNotified": MUTATION,
  "prHub.markReady": MUTATION,
  "prHub.markSeen": MUTATION,
  "prHub.merge": MUTATION,
  "prHub.peek": READ,
  "prHub.prepareComment": MUTATION,
  "prHub.prepareOperation": MUTATION,
  "prHub.prepareQuickReview": MUTATION,
  "prHub.prepareReview": MUTATION,
  "prHub.recoverComment": MUTATION,
  "prHub.recoverOperation": MUTATION,
  "prHub.recoverReply": MUTATION,
  "prHub.recoverReview": MUTATION,
  "prHub.refresh": MUTATION,
  "prHub.removeAccount": MUTATION,
  "prHub.removeAccountRouting": MUTATION,
  "prHub.replyReviewThread": MUTATION,
  "prHub.requestChanges": MUTATION,
  "prHub.reRequestReview": MUTATION,
  "prHub.resolveLocalCheckout": MUTATION,
  "prHub.saveAccount": MUTATION,
  "prHub.saveReplyDraft": MUTATION,
  "prHub.saveReviewDraft": MUTATION,
  "prHub.setAccountRouting": MUTATION,
  "prHub.setReaction": MUTATION,
  "prHub.setReviewThreadState": MUTATION,
  "prHub.setViewedFile": MUTATION,
  "prHub.snooze": MUTATION,
  "prHub.submitComment": MUTATION,
  "prHub.submitOperation": MUTATION,
  "prHub.submitReview": MUTATION,
  "prHub.track": MUTATION,
  "prHub.unsnooze": MUTATION,
  "prHub.updateBranch": MUTATION,
  "prHub.updateComment": MUTATION,

  "profiles.create": MUTATION,
  "profiles.delete": MUTATION,
  "profiles.list": READ,
  "profiles.update": MUTATION,

  "projects.authorizeEntry": MUTATION,
  "projects.cancelContentSearch": MUTATION,
  "projects.clone": MUTATION,
  "projects.cloneCancel": STOP,
  "projects.cloneList": READ,
  "projects.createNew": MUTATION_RT,
  "projects.ensureScratch": MUTATION_RT,
  "projects.findByRepository": MUTATION_RT,
  "projects.getCheckedInConfig": READ,
  "projects.issueAssetUrl": MUTATION,
  "projects.listDirectory": READ,
  "projects.listEntries": READ,
  "projects.openHtmlPreview": MUTATION,
  "projects.readFile": READ,
  "projects.searchContents": READ,
  "projects.searchEntries": READ,
  "projects.setWatchedPaths": CONNECTION_CONTROL,
  "projects.writeFile": MUTATION,

  "providerAccount.cancel": STOP,
  "providerAccount.input": MUTATION,
  "providerAccount.loginStart": MUTATION,
  "providerAccount.logout": MUTATION,
  "providerAccount.status": READ,

  "pullRequestWatches.list": MUTATION_RT,
  "pullRequestWatches.start": MUTATION_RT,
  "pullRequestWatches.stop": MUTATION_RT,

  "review.previewDiff": READ_RT,

  "scheduledTasks.acknowledgeNotifications": MUTATION,
  "scheduledTasks.claimNotifications": MUTATION,
  "scheduledTasks.create": MUTATION_RT,
  "scheduledTasks.delete": MUTATION,
  "scheduledTasks.findRunForTurn": MUTATION,
  "scheduledTasks.get": MUTATION,
  "scheduledTasks.list": MUTATION,
  "scheduledTasks.listRuns": MUTATION,
  "scheduledTasks.previewSchedule": MUTATION_RT,
  "scheduledTasks.resolveRun": MUTATION_RT,
  "scheduledTasks.runNow": MUTATION,
  "scheduledTasks.setEnabled": MUTATION,
  "scheduledTasks.update": MUTATION_RT,

  "server.addKeybinding": MUTATION,
  "server.checkProviderUpdates": MUTATION,
  "server.getClaudeTranscriptRepair": READ_RT,
  "server.getConfig": READ,
  "server.getProjectSettings": READ,
  "server.getProviderInventory": READ,
  "server.migrateClientSetting": MUTATION,
  "server.probe": HEALTH,
  "server.refreshProviders": MUTATION,
  "server.removeKeybinding": MUTATION,
  "server.repairClaudeTranscript": MUTATION_RT,
  "server.reportClientDiagnostics": MUTATION,
  "server.resetKeybindings": MUTATION,
  "server.runProviderUpdate": long(false, 660_000),
  "server.undoClaudeTranscriptRepair": MUTATION_RT,
  "server.updateKeybinding": MUTATION,
  "server.updateSettings": MUTATION,
  "server.upsertKeybinding": MUTATION,
  "server.validateHarnesses": MUTATION,

  "shell.openInEditor": MUTATION,
  "shell.revealInFileManager": MUTATION,

  "storage.automationAudit": MUTATION,
  "storage.automationDryRun": MUTATION_RT,
  "storage.cancelCleanup": STOP_RT,
  "storage.cleanup": MUTATION_RT,
  "storage.getDiskSpace": READ,
  "storage.getOperation": READ_RT,
  "storage.getStatus": READ_RT,
  "storage.getTargets": READ_RT,
  "storage.getUsage": READ_RT,

  "terminal.clear": MUTATION,
  "terminal.close": MUTATION,
  "terminal.open": MUTATION_RT,
  "terminal.resize": MUTATION,
  "terminal.restart": MUTATION_RT,
  "terminal.snapshot": READ,
  "terminal.write": MUTATION,

  "threads.search": READ,

  "threadSettlement.settleProjectIdle": MUTATION_RT,

  "upstreamPorts.acceptSuggestions": MUTATION_RT,
  "upstreamPorts.addRemote": MUTATION_RT,
  "upstreamPorts.controlPortQueue": MUTATION_RT,
  "upstreamPorts.decide": MUTATION_RT,
  "upstreamPorts.dequeuePort": MUTATION_RT,
  "upstreamPorts.enqueuePort": MUTATION_RT,
  "upstreamPorts.getOverview": READ_RT,
  "upstreamPorts.getPortPrompt": READ_RT,
  "upstreamPorts.getPortQueue": MUTATION_RT,
  "upstreamPorts.getTopic": READ_RT,
  "upstreamPorts.getTopicFiles": READ_RT,
  "upstreamPorts.listProjects": READ_RT,
  "upstreamPorts.listTopicIds": READ_RT,
  "upstreamPorts.listTopics": READ_RT,
  "upstreamPorts.previewPortGroups": READ_RT,
  "upstreamPorts.resolvePublication": MUTATION_RT,
  "upstreamPorts.retryPortReview": MUTATION_RT,
  "upstreamPorts.run": MUTATION_RT,
  "upstreamPorts.startPort": MUTATION_RT,
  "upstreamPorts.takeOverWriter": MUTATION_RT,
  "upstreamPorts.undoDecisions": MUTATION_RT,
  "upstreamPorts.unlinkPort": MUTATION_RT,

  "usage.consumeResetCredit": MUTATION_RT,
  "usage.getAccounts": READ_RT,
  "usage.getQuotaHistory": MUTATION_RT,
  "usage.getSummary": READ_RT,

  "workflowPlatform.createRun": MUTATION_RT,
  "workflowPlatform.inspectRun": READ_RT,
  "workflowPlatform.listTemplates": READ,

  "worktrees.discardMovedChanges": MUTATION_RT,
  "worktrees.getTransition": MUTATION_RT,
  "worktrees.inspect": MUTATION_RT,
  "worktrees.list": READ_RT,
  "worktrees.moveThread": long(true, null),
  "worktrees.previewTransitionRecovery": MUTATION_RT,
  "worktrees.recover": MUTATION_RT,
  "worktrees.remove": MUTATION_RT,
  "worktrees.resolveTransition": long(true, null),
  "worktrees.switchWorkspace": long(true, null),
  "worktrees.threadState": MUTATION_RT,

  "worktreeSetup.cancel": STOP_RT,
  "worktreeSetup.retry": MUTATION_RT,
  "worktreeSetup.subscribe": MUTATION_RT,
  "worktreeSetup.workLocally": MUTATION_RT,
} as const satisfies Record<WsRequestTag, RpcMethodPolicy>;

/** Multiplexed orchestration commands that must not queue behind ordinary work. */
export const ORCHESTRATION_COMMAND_LANES = {
  "thread.turn.interrupt": "stop",
  "thread.session.stop": "stop",
  "thread.approval.respond": "answer",
  "thread.user-input.respond": "answer",
  "thread.turn.steer": "answer",
} as const satisfies Partial<Record<ClientOrchestrationCommand["type"], RpcLane>>;

export function rpcMethodPolicy(method: string): RpcMethodPolicy | undefined {
  return Object.hasOwn(RPC_METHOD_POLICY, method)
    ? RPC_METHOD_POLICY[method as WsRequestTag]
    : undefined;
}

function commandType(body: { readonly command?: unknown }): string {
  return body.command && typeof body.command === "object" && "type" in body.command
    ? String(body.command.type)
    : "";
}

/** Inspect the decoded command as well as its transport method. */
export function rpcLane(body: { readonly _tag: string; readonly command?: unknown }): RpcLane {
  if (body._tag === "orchestration.dispatchCommand") {
    const type = commandType(body);
    if (Object.hasOwn(ORCHESTRATION_COMMAND_LANES, type))
      return ORCHESTRATION_COMMAND_LANES[type as keyof typeof ORCHESTRATION_COMMAND_LANES];
  }
  return rpcMethodPolicy(body._tag)?.lane ?? "ordinary";
}

/**
 * Connectivity admission only: reads and connection controls may be sent
 * before synchronization and retried after `RpcBusy`. Unknown methods require
 * reconciliation.
 */
export function isReadOnlyRpc(method: string): boolean {
  const kind = rpcMethodPolicy(method)?.kind;
  return kind === "read" || kind === "connection-control";
}

/**
 * Routes that await the orchestration runtime only on a branch the request
 * body selects. Each predicate mirrors the route's own condition.
 */
const BODY_RUNTIME_DEPENDENCIES: Partial<
  Record<WsRequestTag, (body: Readonly<Record<string, unknown>>) => boolean>
> = {
  // Local checkout switches the thread's workspace.
  "git.preparePullRequestThread": (body) => body.mode === "local",
  // The feature-branch step switches the workspace.
  "git.runStackedAction": (body) => Boolean(body.featureBranch),
  "server.getProviderInventory": (body) => Boolean(body.projectId),
  "server.updateSettings": (body) => Boolean(body.projectSettingsOverrides),
};

/** Whether this request waits for the orchestration runtime, from its method and body. */
export function rpcRequiresRuntime(body: { readonly _tag: string }): boolean {
  if (rpcMethodPolicy(body._tag)?.requiresRuntime) return true;
  const dependsOnBody = Object.hasOwn(BODY_RUNTIME_DEPENDENCIES, body._tag)
    ? BODY_RUNTIME_DEPENDENCIES[body._tag as WsRequestTag]
    : undefined;
  return dependsOnBody?.(body as Readonly<Record<string, unknown>>) ?? false;
}

/**
 * The client's execution deadline for a long-lane request, or `undefined` for
 * the transport default. MCP login only needs the OAuth window for Codex.
 */
export function rpcLongRunningTimeoutMs(body: {
  readonly _tag: string;
  readonly provider?: unknown;
}): number | null | undefined {
  const policy = rpcMethodPolicy(body._tag);
  if (policy?.lane !== "long") return undefined;
  if (body._tag === "mcp.startLogin" && body.provider !== "codex") return undefined;
  return policy.longRunningTimeoutMs;
}

export const RPC_LANE_LIMITS: Readonly<Record<RpcLane, number>> = {
  ordinary: 8,
  stop: 1,
  answer: 2,
  recovery: 1,
  long: 4,
  health: 1,
};
export const RPC_ORDINARY_BYTES = 80 * 1024 * 1024;
export const RPC_CONTROL_BYTES = 40 * 1024 * 1024;

export function rpcLaneByteBudget(lane: RpcLane): number {
  return lane === "ordinary" ? RPC_ORDINARY_BYTES : RPC_CONTROL_BYTES;
}

export interface RpcLaneSnapshot {
  readonly count: number;
  readonly bytes: number;
  /** Age of the oldest claim still held, or `null` when the lane is idle. */
  readonly oldestAgeMs: number | null;
}

const emptyLaneRecord = <A>(value: () => A): Record<RpcLane, A> => ({
  ordinary: value(),
  stop: value(),
  answer: value(),
  recovery: value(),
  long: value(),
  health: value(),
});

/** No waiting queue: reject overload before executing or retaining its payload. */
export class RpcAdmission {
  private readonly counts = emptyLaneRecord(() => 0);
  private readonly bytes = emptyLaneRecord(() => 0);
  private readonly claims = emptyLaneRecord(() => new Set<{ readonly at: number }>());

  constructor(private readonly now: () => number = Date.now) {}

  claim(lane: RpcLane, bytes: number): (() => void) | null {
    if (
      this.counts[lane] >= RPC_LANE_LIMITS[lane] ||
      this.bytes[lane] + bytes > rpcLaneByteBudget(lane)
    )
      return null;
    this.counts[lane]++;
    this.bytes[lane] += bytes;
    const claim = { at: this.now() };
    this.claims[lane].add(claim);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.counts[lane]--;
      this.bytes[lane] -= bytes;
      this.claims[lane].delete(claim);
    };
  }

  /** True when a claim of `bytes` would succeed right now. */
  canClaim(lane: RpcLane, bytes: number): boolean {
    return (
      this.counts[lane] < RPC_LANE_LIMITS[lane] &&
      this.bytes[lane] + bytes <= rpcLaneByteBudget(lane)
    );
  }

  inFlight(lane: RpcLane): number {
    return this.counts[lane];
  }

  snapshot(): Readonly<Record<RpcLane, RpcLaneSnapshot>> {
    const now = this.now();
    const result = emptyLaneRecord<RpcLaneSnapshot>(() => ({
      count: 0,
      bytes: 0,
      oldestAgeMs: null,
    }));
    for (const lane of RPC_LANES) {
      let oldest: number | null = null;
      for (const claim of this.claims[lane])
        if (oldest === null || claim.at < oldest) oldest = claim.at;
      result[lane] = {
        count: this.counts[lane],
        bytes: this.bytes[lane],
        oldestAgeMs: oldest === null ? null : Math.max(0, now - oldest),
      };
    }
    return result;
  }
}
