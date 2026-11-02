import { Schema } from "effect";
import {
  ComputerAutomationError,
  ComputerInspectResult,
  ComputerScreenshot,
  ComputerApp,
  ComputerActionResult,
  DesktopComputerHostMessage,
  ProviderApprovalDecision,
  type ComputerAutomationRequest,
} from "@t3tools/contracts";
import { RehearsalResponses, rehearsalExecutionCode } from "./rehearsalResponses";
import { MCP_DIAGNOSTIC_PREFIX, RehearsalMcpTransportReceipt } from "./rehearsalMcpTransport";

/** Development-only IPC observer. Never changes messages or keeps raw tool I/O. */
export class ElectronRehearsalObservation {
  private readonly responses = new RehearsalResponses();
  private readonly admitted = new Set<string>();
  private readonly pending = new Map<string, ComputerAutomationRequest["op"] | "leaseAcquire">();
  private readonly elementActions = new Map<string, string>();
  private readonly backgroundTargets = new Map<string, string>();
  private readonly operations: Array<Record<string, string | number | boolean>> = [];
  private held = false;
  private leaseObserved = false;
  private pauseObserved = false;
  private resumeObserved = false;
  private captureResponses = 0;
  private inspectionResponses = 0;
  private activityMessages = 0;
  private activityThumbnails = 0;
  private readonly toolOutcomeErrors = new Set<string>();
  private overflow = false;
  private readonly accessRequests = new Set<string>();
  private readonly accessAnswers = new Set<string>();
  private readonly accessKinds = new Map<string, string>();
  private readonly accessAnswerSummaries: Array<{
    kind: string;
    appCount: number;
    allowed: number;
    remembered: number;
    allowSessionActions?: boolean;
  }> = [];
  private readonly sessions = new Set<string>();
  private readonly requestSessions: Array<{ op: string; sessionOrdinal: number }> = [];
  private backendLogBuffer = "";
  private restartLinesRemaining = 0;
  private readonly backendRestarts: Array<{ reasons: string[] }> = [];
  private readonly backendLifecycle = new Set<string>();
  private readonly mcpTransport: RehearsalMcpTransportReceipt[] = [];
  private mcpTransportOverflow = false;
  constructor(private readonly admissionLimit = 128) {
    if (!Number.isSafeInteger(admissionLimit) || admissionLimit < 128 || admissionLimit > 2048)
      throw new Error("Invalid rehearsal observation limit.");
  }
  /** Observe existing backend stdout without retaining text, paths or IDs. */
  backendLog(chunk: string): void {
    this.backendLogBuffer += chunk;
    if (this.backendLogBuffer.length > 64 * 1024) {
      this.backendLogBuffer = "";
      this.restartLinesRemaining = 0;
      this.mcpTransportOverflow = true;
      return;
    }
    let end;
    while ((end = this.backendLogBuffer.indexOf("\n")) >= 0) {
      const line = this.backendLogBuffer.slice(0, end).replace(/\u001b\[[0-9;]*m/g, "");
      this.backendLogBuffer = this.backendLogBuffer.slice(end + 1);
      if (line.startsWith(MCP_DIAGNOSTIC_PREFIX)) {
        try {
          const receipt: unknown = JSON.parse(line.slice(MCP_DIAGNOSTIC_PREFIX.length));
          if (
            !Schema.is(RehearsalMcpTransportReceipt)(receipt) ||
            this.mcpTransport.length >= this.admissionLimit
          )
            this.mcpTransportOverflow = true;
          else
            this.mcpTransport.push({
              method: receipt.method,
              sessionHeader: receipt.sessionHeader,
              status: receipt.status,
              bounded: receipt.bounded,
              requestDecoded: receipt.requestDecoded,
              responseDecoded: receipt.responseDecoded,
              completed: receipt.completed,
              outcome: receipt.outcome,
            });
        } catch {
          this.mcpTransportOverflow = true;
        }
        continue;
      }
      for (const [message, code] of [
        ["provider launch identity changed; replacing active session", "launch-identity-changed"],
        [
          "provider service resumed provider session from persisted binding",
          "persisted-session-resumed",
        ],
        ["provider service adopted existing provider session", "existing-session-adopted"],
        ["ignored Claude stream exit because the session already stopped", "retired-stream-exit"],
        ["claude session ended", "claude-session-ended"],
      ] as const) {
        if (line.includes(message)) this.backendLifecycle.add(code);
      }
      if (line.includes("provider command reactor restarting provider session")) {
        if (this.backendRestarts.length >= 16) continue;
        this.backendRestarts.push({ reasons: [] });
        this.restartLinesRemaining = 64;
      }
      if (this.restartLinesRemaining <= 0) continue;
      this.restartLinesRemaining--;
      const current = this.backendRestarts.at(-1)!;
      for (const [flag, reason] of [
        ["runtimeModeChanged", "runtime-mode-changed"],
        ["providerChanged", "provider-changed"],
        ["instanceChanged", "instance-changed"],
        ["shouldRestartForModelChange", "model-changed"],
        ["shouldRestartForModelOptionsChange", "model-options-changed"],
        ["shouldRestartForProviderOptionsChange", "provider-options-changed"],
        ["shouldRestartForProjectMcpChange", "project-mcp-changed"],
        ["shouldRestartForComputerUseChange", "computer-use-changed"],
        ["shouldRestartForCwdChange", "cwd-changed"],
        ["shouldRestartForWorkflowExecutionProfileChange", "workflow-execution-profile-changed"],
      ] as const) {
        if (
          new RegExp(`\\b${flag}["']?\\s*[:=]\\s*true\\b`).test(line) &&
          !current.reasons.includes(reason)
        )
          current.reasons.push(reason);
      }
    }
  }
  private grantChanges = 0;
  private lastGrantCount = 0;
  private hostStatus: { available: boolean; reason?: string } | undefined;
  receive(input: unknown): void {
    // Decode (not `is`): legacy holders without a scope decode to the foreground scope.
    const decoded = Schema.decodeUnknownExit(DesktopComputerHostMessage)(input);
    if (decoded._tag !== "Success") return;
    const raw = decoded.value;
    if (raw.type === "status") {
      this.hostStatus = raw.status.available
        ? { available: true }
        : { available: false, reason: raw.status.reason };
    } else if (raw.type === "activity") {
      this.activityMessages++;
      if (raw.activity.thumbnailDataUrl) this.activityThumbnails++;
      if (raw.activity.outcome) this.toolOutcomeErrors.add(raw.activity.outcome);
    } else if (raw.type === "accessRequested") {
      if (this.accessRequests.size >= 128) this.overflow = true;
      else {
        this.accessRequests.add(raw.request.requestId);
        this.accessKinds.set(raw.request.requestId, raw.request.kind);
      }
    } else if (raw.type === "accessAnswer") {
      if (
        this.accessRequests.has(raw.answer.requestId) &&
        !this.accessAnswers.has(raw.answer.requestId)
      ) {
        this.accessAnswers.add(raw.answer.requestId);
        this.accessAnswerSummaries.push({
          kind: this.accessKinds.get(raw.answer.requestId)!,
          appCount: raw.answer.decisions.length,
          allowed: raw.answer.decisions.filter((decision) => decision.allow).length,
          remembered: raw.answer.decisions.filter((decision) => decision.allow && decision.remember)
            .length,
          ...(this.accessKinds.get(raw.answer.requestId) === "session-actions"
            ? { allowSessionActions: raw.answer.allowSessionActions === true }
            : {}),
        });
      }
    } else if (raw.type === "grantsChanged") {
      this.grantChanges++;
      this.lastGrantCount = raw.authorization.grants.length;
    } else if (raw.type === "request" || raw.type === "leaseAcquire") {
      const requestId = raw.type === "request" ? raw.request.requestId : raw.requestId;
      if (this.admitted.has(requestId)) return;
      if (this.admitted.size >= this.admissionLimit) {
        this.overflow = true;
        return;
      }
      this.admitted.add(requestId);
      this.pending.set(requestId, raw.type === "request" ? raw.request.op : "leaseAcquire");
      if (raw.type === "request") {
        this.responses.request(raw.request);
        this.sessions.add(raw.request.authorization.sessionGeneration);
        this.requestSessions.push({
          op: raw.request.op,
          sessionOrdinal:
            [...this.sessions].indexOf(raw.request.authorization.sessionGeneration) + 1,
        });
      }
      if (raw.type === "request" && raw.request.op === "elementAction")
        this.elementActions.set(requestId, raw.request.action);
      if (
        raw.type === "request" &&
        raw.request.delivery === "background" &&
        "appId" in raw.request &&
        raw.request.appId
      )
        this.backgroundTargets.set(requestId, raw.request.appId);
    } else if (raw.type === "response") {
      const op = this.pending.get(raw.requestId);
      if (!op) return;
      this.pending.delete(raw.requestId);
      this.responses.response(raw);
      const summary: Record<string, string | number | boolean> = { op, outcome: "ok" };
      const backgroundApp = this.backgroundTargets.get(raw.requestId);
      this.backgroundTargets.delete(raw.requestId);
      if (backgroundApp && Schema.is(ComputerActionResult)(raw.result)) {
        summary.backgroundDelivery =
          raw.result.delivery === "background" && raw.result.target?.appId === backgroundApp;
      }
      const action = this.elementActions.get(raw.requestId);
      if (action) {
        summary.action = action;
        this.elementActions.delete(raw.requestId);
      }
      if (raw.error !== undefined) {
        if (Schema.is(ComputerAutomationError)(raw.error)) {
          const error = raw.error;
          summary.outcome = error._tag;
          if (error._tag === "Unavailable") summary.reason = error.reason;
          if (error._tag === "Interrupted") summary.cause = error.cause;
          if (error._tag === "TargetBlocked") summary.kind = error.kind;
          if (error._tag === "NotGranted") summary.needed = error.needed;
          if (error._tag === "Execution") {
            const code = rehearsalExecutionCode(error.message);
            if (code) summary.executionCode = code;
          }
        } else summary.outcome = "invalid-error";
      } else if (op === "activateApp" || op === "openApp") {
        if (raw.result && typeof raw.result === "object") {
          const action = raw.result as Record<string, unknown>;
          summary.actionCompleted = action.actionCompleted === true;
          summary.actionCaptureSucceeded =
            Schema.is(ComputerScreenshot)(action.screenshot) && action.screenshot.data.length > 0;
          const error = action.screenshotError;
          if (typeof error === "string" && rehearsalProviderErrorCodes([{ _tag: error }]).length)
            summary.screenshotError = error;
        }
      } else if (op === "type" || op === "elementAction") {
        if (!Schema.is(ComputerActionResult)(raw.result) || raw.result.actionCompleted === false)
          summary.outcome = "invalid-action";
      } else if (op === "listApps") {
        const valid = Schema.is(Schema.Array(ComputerApp))(raw.result);
        summary.validApps = valid;
        if (!valid) summary.outcome = "invalid-apps";
      } else if (op === "screenshot") {
        const valid = Schema.is(ComputerScreenshot)(raw.result) && raw.result.data.length > 0;
        summary.validCapture = valid;
        if (valid) this.captureResponses++;
      } else if (op === "inspect") {
        const valid = Schema.is(ComputerInspectResult)(raw.result);
        if (valid) {
          summary.accessible = raw.result.accessible;
          summary.nodes = raw.result.nodes.length;
          if (raw.result.accessible && raw.result.nodes.length > 0) this.inspectionResponses++;
        } else summary.outcome = "invalid-inspection";
      }
      this.operations.push(summary);
    } else if (raw.type === "leaseChanged") {
      this.held = raw.holder !== null;
      this.leaseObserved ||= this.held;
    } else if (raw.type === "leasesChanged") {
      this.held = raw.holders.length > 0;
      this.leaseObserved ||= this.held;
    } else if (raw.type === "pauseChanged") {
      if (raw.paused) this.pauseObserved = true;
      else this.resumeObserved = true;
    }
  }
  snapshot() {
    return {
      responses: this.responses.checks(),
      hostStatus: this.hostStatus,
      held: this.held,
      leaseObserved: this.leaseObserved,
      pauseObserved: this.pauseObserved,
      resumeObserved: this.resumeObserved,
      captureResponses: this.captureResponses,
      inspectionResponses: this.inspectionResponses,
      activityMessages: this.activityMessages,
      activityThumbnails: this.activityThumbnails,
      toolOutcomeErrors: [...this.toolOutcomeErrors].sort(),
      traceComplete: !this.overflow,
      pendingResponses: this.pending.size,
      accessRequests: this.accessRequests.size,
      accessAnswersForwarded: this.accessAnswers.size,
      accessAnswerSummaries: this.accessAnswerSummaries.map((summary) => ({ ...summary })),
      sessionGenerationsObserved: this.sessions.size,
      requestSessions: this.requestSessions.map((request) => ({ ...request })),
      backendRestarts: this.backendRestarts.map((restart) => ({ reasons: [...restart.reasons] })),
      backendLifecycle: [...this.backendLifecycle].sort(),
      mcpTransport: this.mcpTransport.map((receipt) => ({ ...receipt })),
      mcpTransportOverflow: this.mcpTransportOverflow,
      grantChanges: this.grantChanges,
      lastGrantCount: this.lastGrantCount,
      operations: this.operations.map((operation) => ({ ...operation })),
    };
  }
}

/** Diagnostic categories only, never raw session errors. These hints do not
 * participate in authorization or certify the underlying cause. */
export function rehearsalSessionErrorCode(error: unknown): string {
  if (typeof error !== "string" || !error.trim()) return "none";
  const text = error.slice(0, 8192);
  if (/usage limit|hit.*limit|quota|rate.?limit|credits/i.test(text)) return "usage-limit";
  if (/disabled in settings|provider.*not implemented|provider.*unavailable/i.test(text))
    return "provider-unavailable";
  if (/unsupported-isolation|profile.?isolation|certified Agent SDK/i.test(text))
    return "profile-isolation";
  if (/context.?guard|delivery.?guard/i.test(text)) return "context-guard";
  if (
    /failed to spawn|failed to launch|process exited|executable|ENOENT|EACCES|ReferenceError/i.test(
      text,
    )
  )
    return "cli-launch";
  if (/not logged in|authentication|unauthori[sz]ed|invalid (api key|credentials)/i.test(text))
    return "authentication";
  if (
    /unknown model|invalid model|model.{0,100}(not found|unsupported|unavailable|does not exist)/i.test(
      text,
    )
  )
    return "model-unavailable";
  if (/mcp server|tool schema|sdk mcp/i.test(text)) return "mcp";
  return "unknown";
}

/** Harness diagnostics are enums only. Playwright messages can contain DOM text,
 * tool content or paths and must never be retained in certification evidence. */
export function rehearsalHarnessFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const message = error.message.slice(0, 8192);
  if (message === "Isolation observer snapshot callback failed.") return "observer-snapshot";
  // Playwright can fail before the observer callback runs. Retain only fixed
  // transport categories; its message may otherwise include evaluated content.
  if (
    /Cannot serialize result: object reference chain is too long|Object couldn't be returned by value/.test(
      message,
    )
  )
    return "electron-serialization";
  if (/Execution context was destroyed|Cannot find context with specified id/.test(message))
    return "electron-context-lost";
  if (/Target page, context or browser has been closed|Session closed|Target closed/.test(message))
    return "electron-target-closed";
  if (/^electronApplication\.evaluate(?:Handle)?:/.test(message)) return "electron-evaluation";
  if (message === "External rehearsal transport Unavailable")
    return "external-transport-unavailable";
  if (message === "External rehearsal transport Interrupted")
    return "external-transport-interrupted";
  if (message === "External rehearsal transport OutcomeUnknown")
    return "external-transport-outcome-unknown";
  if (/strict mode violation/i.test(message)) return "ambiguous-locator";
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (message === "Unexpected certification consent request.") return "unexpected-consent";
  if (message === "Unexpected certification consent answer.") return "unexpected-consent-answer";
  if (message === "Physical input interrupted the active turn.") return "physical-input";
  if (message === "Provider turn did not complete.") return "provider-turn-incomplete";
  if (message === "Isolation owner turn ended without a lease.") return "owner-ended-without-lease";
  if (/receipt incomplete\.$/.test(message)) return "incomplete-receipt";
  return "unknown";
}

/** Source locations only, never messages, function arguments or absolute paths. */
export function rehearsalHarnessFailureLocation(error: unknown) {
  const frames: Array<{ source: string; line: number; column: number }> = [];
  if (!(error instanceof Error)) return { kind: "unknown", frames };
  const kind = [
    "Error",
    "TypeError",
    "ReferenceError",
    "RangeError",
    "TimeoutError",
    "SyntaxError",
  ].includes(error.name)
    ? error.name
    : "unknown";
  for (const frame of (error.stack ?? "").slice(0, 16 * 1024).split("\n")) {
    if (!/^\s+at\s/.test(frame)) continue;
    const match = frame.match(
      /\/(rehearse-computer-(?:electron|profile-isolation)\.mjs|rehearsal(?:ProfileIsolation|ExternalClient|ElectronObservation)\.ts):(\d{1,6}):(\d{1,6})\)?$/,
    );
    if (!match) continue;
    const line = Number(match[2]);
    const column = Number(match[3]);
    if (line < 1 || line > 10000 || column < 1 || column > 10000) continue;
    frames.push({ source: match[1]!, line, column });
    if (frames.length === 4) break;
  }
  return { kind, frames };
}

/** Already-sanitized provider activities can contain pre-host tool failures. Keep
 * only known error tags, never their detail strings or arbitrary provider fields. */
export function rehearsalProviderErrorCodes(activities: unknown): string[] {
  const codes = new Set<string>();
  const known = new Set([
    "Unavailable",
    "Busy",
    "Interrupted",
    "OutcomeUnknown",
    "NotGranted",
    "TargetBlocked",
    "GeometryChanged",
    "StaleElement",
    "UnsupportedAction",
    "ReplayRejected",
    "PayloadMismatch",
    "ResultTooLarge",
    "Execution",
  ]);
  let visited = 0;
  const walk = (node: unknown, depth: number): void => {
    if (++visited > 2000 || depth > 12 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const value = node as Record<string, unknown>;
    if (typeof value._tag === "string" && known.has(value._tag)) codes.add(value._tag);
    for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(activities, 0);
  return [...codes].sort();
}

/** Diagnostic counts from the ordinary activity tail, not proof of execution.
 * Never retain IDs, summaries, tool arguments/results or approval contents. */
export function rehearsalProviderActivityCounts(activities: unknown) {
  const kinds: Record<string, string> = {
    "tool.started": "toolStarted",
    "tool.completed": "toolCompleted",
    "approval.requested": "approvalsRequested",
    "approval.resolved": "approvalsResolved",
    "user-input.requested": "userInputsRequested",
    "user-input.resolved": "userInputsResolved",
  };
  const turns = new Map<string | null, Record<string, number>>();
  let boundedOrMalformed = !Array.isArray(activities) || activities.length >= 100;
  for (const activity of Array.isArray(activities) ? activities.slice(0, 100) : []) {
    if (
      !activity ||
      typeof activity !== "object" ||
      typeof activity.kind !== "string" ||
      !(
        activity.turnId === null ||
        (typeof activity.turnId === "string" && activity.turnId.length <= 256)
      )
    ) {
      boundedOrMalformed = true;
      continue;
    }
    let counts = turns.get(activity.turnId);
    if (!counts) {
      if (turns.size >= 16) {
        boundedOrMalformed = true;
        continue;
      }
      counts = {
        toolStarted: 0,
        toolCompleted: 0,
        toolFailed: 0,
        toolDeclined: 0,
        approvalsRequested: 0,
        approvalsResolved: 0,
        approvalsAccepted: 0,
        approvalsDeclined: 0,
        approvalsCancelled: 0,
        approvalsUnknown: 0,
        userInputsRequested: 0,
        userInputsResolved: 0,
        other: 0,
      };
      turns.set(activity.turnId, counts);
    }
    const key = Object.hasOwn(kinds, activity.kind) ? kinds[activity.kind]! : "other";
    counts[key] = (counts[key] ?? 0) + 1;
    if (activity.kind === "approval.resolved") {
      const decision: unknown = activity.payload?.decision;
      const field = !Schema.is(ProviderApprovalDecision)(decision)
        ? "approvalsUnknown"
        : decision === "decline"
          ? "approvalsDeclined"
          : decision === "cancel"
            ? "approvalsCancelled"
            : "approvalsAccepted";
      counts[field] = (counts[field] ?? 0) + 1;
    }
    if (activity.kind === "tool.completed") {
      const status = activity.payload?.status;
      if (status === "failed") counts.toolFailed!++;
      if (status === "declined") counts.toolDeclined!++;
    }
  }
  return {
    observed: Array.isArray(activities),
    boundedOrMalformed,
    turns: [...turns.values()].map((counts, index) => ({ turnOrdinal: index + 1, ...counts })),
  };
}
