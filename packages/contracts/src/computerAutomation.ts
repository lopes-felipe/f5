import { Schema } from "effect";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const NonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThan(0));
const Size = Schema.Struct({ width: Positive, height: Positive });
const Point = Schema.Struct({ x: NonNegative, y: NonNegative });
const Rect = Schema.Struct({ x: NonNegative, y: NonNegative, width: Positive, height: Positive });
const Modifier = Schema.Literals(["Alt", "Control", "Meta", "Shift"]);
export const ComputerPermission = Schema.Literals(["screen-recording", "accessibility"]);
export type ComputerPermission = typeof ComputerPermission.Type;
export const ComputerBackendKind = Schema.Literals(["native", "claude-builtin", "codex-builtin"]);
export type ComputerBackendKind = typeof ComputerBackendKind.Type;
export const ComputerBackendSelection = Schema.Struct({
  kind: ComputerBackendKind,
  fallbackFrom: Schema.optional(
    Schema.Struct({ kind: ComputerBackendKind, reason: Schema.String }),
  ),
});
export type ComputerBackendSelection = typeof ComputerBackendSelection.Type;
export const ComputerAutomationUnavailableReason = Schema.Literals([
  "not-certified",
  "unsupported-platform",
  "missing-permissions",
  "disabled",
  "no-host",
  "helper-missing",
  "helper-crashed",
  "os-too-old",
  "monitor-unhealthy",
  "other-instance",
]);
export type ComputerAutomationUnavailableReason = typeof ComputerAutomationUnavailableReason.Type;
export const ComputerDisplay = Schema.Struct({
  displayId: Id,
  geometryGeneration: Id,
  primary: Schema.Boolean,
  nativeBounds: Schema.Struct({
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite.check(Schema.isGreaterThan(0)),
    height: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
  pixelSize: Size,
  rotation: Schema.Finite,
  modelSize: Size,
});
export type ComputerDisplay = typeof ComputerDisplay.Type;
/** Capability token: background accessibility delivery (helper, desktop and backend). */
export const COMPUTER_BACKGROUND_CAPABILITY = "background-ax-v1";
export const ComputerBackgroundUnavailableReason = Schema.Literals([
  "unsupported-platform",
  "peer-capability",
  "preview-off",
  "permissions",
  "monitor-unhealthy",
]);
export type ComputerBackgroundUnavailableReason = typeof ComputerBackgroundUnavailableReason.Type;
export const ComputerBackgroundStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(ComputerBackgroundUnavailableReason),
});
export type ComputerBackgroundStatus = typeof ComputerBackgroundStatus.Type;
export const ComputerPasswordMasking = Schema.Literals(["fast", "conservative"]);
export type ComputerPasswordMasking = typeof ComputerPasswordMasking.Type;
export const ComputerAutomationBackendStatus = Schema.Union([
  Schema.Struct({
    available: Schema.Literal(true),
    displays: Schema.optional(Schema.Array(ComputerDisplay)),
    background: Schema.optional(ComputerBackgroundStatus),
    /** Absent on legacy helpers and platforms without selectable password masking. */
    passwordMaskingSupported: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    available: Schema.Literal(false),
    reason: ComputerAutomationUnavailableReason,
    detail: Schema.optional(Schema.String),
    missing: Schema.optional(Schema.Array(ComputerPermission)),
  }),
]);
export type ComputerAutomationBackendStatus = typeof ComputerAutomationBackendStatus.Type;
export const ComputerAppTier = Schema.Literals(["blocked", "view", "click", "full"]);
export type ComputerAppTier = typeof ComputerAppTier.Type;
export const ComputerGrant = Schema.Struct({
  receipt: Schema.optionalKey(Id),
  appId: Id,
  tier: ComputerAppTier,
  allowTyping: Schema.Boolean,
});
export type ComputerGrant = typeof ComputerGrant.Type;
export const ComputerApp = Schema.Struct({
  appId: Id,
  name: Schema.String.check(Schema.isMaxLength(200)),
  running: Schema.Boolean,
  frontmost: Schema.Boolean,
  tier: ComputerAppTier,
  warning: Schema.optional(Schema.Literal("browser")),
  grant: Schema.optional(
    Schema.Struct({ allowTyping: Schema.Boolean, source: Schema.Literals(["session", "project"]) }),
  ),
});
export type ComputerApp = typeof ComputerApp.Type;
export const ComputerAuthorization = Schema.Struct({
  projectId: Schema.optionalKey(Id),
  profileId: Id,
  threadId: Id,
  sessionGeneration: Id,
  turnId: Id,
  executionGeneration: Positive,
  grantVersion: NonNegative,
  grants: Schema.Array(ComputerGrant).check(Schema.isMaxLength(100)),
});
export type ComputerAuthorization = typeof ComputerAuthorization.Type;
export const ComputerElementAction = Schema.Literals([
  "press",
  "focus",
  "setValue",
  "increment",
  "decrement",
  "showMenu",
  "scrollIntoView",
]);
export type ComputerElementAction = typeof ComputerElementAction.Type;
/** Background acts inside one app through accessibility; foreground posts system input. */
export const ComputerDelivery = Schema.Literals(["background", "foreground"]);
export type ComputerDelivery = typeof ComputerDelivery.Type;
export const COMPUTER_AGENT_IDENTITY_CAPABILITY = "computer-agent-identity-v1";
export const COMPUTER_ACTIVITY_CORRELATION_CAPABILITY = "computer-activity-correlation-v1";
export const ComputerAgentProviderSchema = Schema.Literals([
  "claude",
  "codex",
  "cursor",
  "grok",
  "antigravity",
]);
const Envelope = {
  requestId: Id,
  payloadHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  authorization: ComputerAuthorization,
  deadlineAtMs: Positive,
  agent: Schema.Struct({
    provider: ComputerAgentProviderSchema,
    threadTitle: Schema.String.check(Schema.isMaxLength(200)),
  }),
  screenshot: Schema.optional(Schema.Boolean),
  /** Missing means foreground, the only delivery legacy peers understand. */
  delivery: Schema.optional(ComputerDelivery),
  /** User policy injected by the broker; absent requests retain the legacy child walk. */
  passwordMasking: Schema.optional(ComputerPasswordMasking),
};
const Coordinates = { displayId: Id, geometryGeneration: Id, x: NonNegative, y: NonNegative };
export const ComputerAutomationRequest = Schema.Union([
  Schema.Struct({ ...Envelope, op: Schema.Literal("status") }),
  Schema.Struct({ ...Envelope, op: Schema.Literal("listApps") }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("resolveApps"),
    queries: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("screenshot"),
    displayId: Schema.optional(Id),
    appId: Schema.optional(Id),
  }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("zoom"),
    displayId: Id,
    rect: Rect,
    appId: Schema.optional(Id),
  }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("inspect"),
    appId: Id,
    maxNodes: Positive.check(Schema.isLessThanOrEqualTo(800)),
    snapshotId: Schema.optional(Id),
    elementRef: Schema.optional(Id),
  }),
  Schema.Struct({
    ...Envelope,
    ...Coordinates,
    op: Schema.Literal("click"),
    button: Schema.Literals(["left", "right", "middle"]),
    clickCount: Positive.check(Schema.isLessThanOrEqualTo(3)),
    modifiers: Schema.Array(Modifier).check(Schema.isMaxLength(4)),
  }),
  Schema.Struct({ ...Envelope, ...Coordinates, op: Schema.Literal("move") }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("drag"),
    displayId: Id,
    geometryGeneration: Id,
    from: Point,
    to: Point,
  }),
  Schema.Struct({
    ...Envelope,
    ...Coordinates,
    op: Schema.Literal("scroll"),
    deltaX: Schema.Finite.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
    deltaY: Schema.Finite.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
  }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(10_000)),
    appId: Schema.optional(Id),
  }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("key"),
    chords: Schema.Array(Id).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
    repeat: Positive.check(Schema.isLessThanOrEqualTo(20)),
  }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("elementAction"),
    appId: Id,
    snapshotId: Id,
    elementRef: Id,
    action: ComputerElementAction,
    value: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))),
  }),
  Schema.Struct({ ...Envelope, op: Schema.Literal("openApp"), appId: Id }),
  Schema.Struct({ ...Envelope, op: Schema.Literal("activateApp"), appId: Id }),
]);
export type ComputerAutomationRequest = typeof ComputerAutomationRequest.Type;
export type ComputerAutomationOperation = ComputerAutomationRequest["op"];
/** Content-free diagnostics from the macOS password audit; absent on older helpers. */
const ComputerSecureAuditDiagnostics = Schema.Struct({
  searchEnabled: Schema.Boolean,
  elapsedMs: NonNegative,
  windows: Schema.Array(
    Schema.Struct({
      windowIndex: NonNegative,
      /** The audit finished; accessibility may still omit visually present fields. */
      complete: Schema.Boolean,
      elapsedMs: NonNegative,
      visitedNodes: NonNegative,
      nodeReadElapsedMs: NonNegative,
      maxChildren: NonNegative,
      textFieldQueries: NonNegative,
      frameQueries: NonNegative,
      searchResults: NonNegative,
      searchElapsedMs: NonNegative,
      searchFallbacks: NonNegative,
      invalidSearchResults: NonNegative,
      stopReasons: Schema.Array(
        Schema.Literals([
          "deadline",
          "node-budget",
          "depth-limit",
          "unreadable-node",
          "unreadable-children",
          "secure-field-without-frame",
          "search-limit",
          "search-incomplete",
          "window-match",
        ]),
      ),
      axFailures: Schema.Array(
        Schema.Struct({
          operation: Schema.Literals([
            "node-read",
            "role",
            "subrole",
            "children",
            "text-fields",
            "frames",
          ]),
          error: Schema.Int,
          count: Positive,
        }),
      ).check(Schema.isMaxLength(32)),
    }),
  ),
});
export const ComputerScreenshot = Schema.Struct({
  displayId: Id,
  geometryGeneration: Id,
  modelSize: Size,
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMaxLength(8 * 1024 * 1024)),
  hiddenContent: Schema.Boolean,
  passwordMasking: Schema.optional(ComputerPasswordMasking),
  masked: Schema.optional(Schema.Literals(["none", "fields", "web-area", "window"])),
  maskReasons: Schema.optional(
    Schema.Array(
      Schema.Literals(["window-match", "audit-incomplete", "partial-audit", "windows-changed"]),
    ),
  ),
  secureAudit: Schema.optional(ComputerSecureAuditDiagnostics),
});
export type ComputerScreenshot = typeof ComputerScreenshot.Type;
export const ComputerAutomationScreenshot = ComputerScreenshot;
export type ComputerAutomationScreenshot = ComputerScreenshot;
export const ComputerZoomResult = Schema.Struct({ ...ComputerScreenshot.fields, rect: Rect });
export type ComputerZoomResult = typeof ComputerZoomResult.Type;
export const ComputerActionResult = Schema.Struct({
  displayId: Id,
  geometryGeneration: Id,
  frontmostApp: Schema.NullOr(ComputerApp),
  cursor: Schema.NullOr(Schema.Struct({ displayId: Id, x: Schema.Finite, y: Schema.Finite })),
  screenshot: Schema.optional(ComputerScreenshot),
  screenshotError: Schema.optional(Schema.String.check(Schema.isMaxLength(100))),
  actionCompleted: Schema.optional(Schema.Boolean),
  thumbnail: Schema.optional(Schema.String.check(Schema.isMaxLength(40 * 1024))),
  delivery: Schema.optional(ComputerDelivery),
  target: Schema.optional(Schema.Struct({ appId: Id, windowBounds: Schema.optional(Rect) })),
  /** Bounded read-back facts only; document text is never returned. */
  verification: Schema.optional(
    Schema.Struct({
      verified: Schema.Boolean,
      matchesRequestedValue: Schema.optional(Schema.Boolean),
      valueLength: Schema.optional(NonNegative),
    }),
  ),
  /** Set when a background mutation waited for a secure field and did not run. */
  waiting: Schema.optional(Schema.Literal("secure-input")),
});
export type ComputerActionResult = typeof ComputerActionResult.Type;
export const ComputerInspectResult = Schema.Struct({
  snapshotId: Id,
  appId: Id,
  accessible: Schema.Boolean,
  truncated: Schema.optional(Schema.Boolean),
  nodes: Schema.Array(
    Schema.Struct({
      elementRef: Id,
      role: Schema.String.check(Schema.isMaxLength(200)),
      name: Schema.String.check(Schema.isMaxLength(200)),
      value: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      displayId: Schema.optional(Id),
      bounds: Schema.optional(Rect),
      focused: Schema.Boolean,
      enabled: Schema.Boolean,
      actions: Schema.Array(ComputerElementAction),
    }),
  ).check(Schema.isMaxLength(800)),
});
export type ComputerInspectResult = typeof ComputerInspectResult.Type;
export const ComputerForegroundRequiredReason = Schema.Literals([
  "unsupported-in-background",
  "unsupported-app",
  "window-unavailable",
  "typing-unsupported",
  "activation-side-effect",
]);
export type ComputerForegroundRequiredReason = typeof ComputerForegroundRequiredReason.Type;
export const ComputerAutomationError = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Unavailable"),
    reason: ComputerAutomationUnavailableReason,
    missing: Schema.optional(Schema.Array(ComputerPermission)),
    captureFailure: Schema.optional(
      Schema.Struct({
        stage: Schema.Literals(["permission-preflight", "shareable-content", "image-capture"]),
        domain: Schema.optional(Schema.Literals(["screen-capture-kit", "other"])),
        code: Schema.optional(Schema.Int),
      }),
    ),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Busy"),
    holder: Schema.Literals(["same-profile", "other-profile"]),
    threadTitle: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.Literal("observation-backlog")),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Interrupted"),
    cause: Schema.Literals([
      "paused",
      "user-input",
      "kill-switch",
      "access-changed",
      "policy-changed",
      "turn-ended",
      "permit-expired",
    ]),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ForegroundRequired"),
    reason: ComputerForegroundRequiredReason,
    restored: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    _tag: Schema.Literal("NotGranted"),
    appName: Schema.optional(Schema.String),
    needed: Schema.Literals(["view", "click", "type"]),
  }),
  Schema.Struct({
    _tag: Schema.Literal("TargetBlocked"),
    kind: Schema.Literals([
      "f5",
      "system-ui",
      "secure-field",
      "focus-unknown",
      "elevated",
      "owner-unknown",
      "protection-unknown",
      "user-active",
      "other-app",
      "foreground-busy",
    ]),
  }),
  Schema.Struct({ _tag: Schema.Literal("Execution"), message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("StaleElement"),
    reason: Schema.optional(
      Schema.Literals(["snapshot-expired", "window-changed", "element-gone", "role-changed"]),
    ),
  }),
  Schema.Struct({
    _tag: Schema.Literals([
      "OutcomeUnknown",
      "GeometryChanged",
      "UnsupportedAction",
      "ReplayRejected",
      "PayloadMismatch",
      "ResultTooLarge",
    ]),
  }),
]);
export type ComputerAutomationError = typeof ComputerAutomationError.Type;
export const ComputerAccessRequested = Schema.Struct({
  projectId: Schema.optionalKey(Id),
  sessionGeneration: Schema.optionalKey(Id),
  requestId: Id,
  threadId: Id,
  reason: Schema.String.check(Schema.isMaxLength(500)),
  kind: Schema.Literals([
    "apps",
    "session-actions",
    "chrome-setup",
    "chrome-session",
    "foreground-takeover",
  ]),
  typingRequested: Schema.optionalKey(Schema.Boolean),
  /** Session approval that also covers background control while the user works elsewhere. */
  background: Schema.optionalKey(Schema.Boolean),
  takeover: Schema.optionalKey(
    Schema.Struct({
      appId: Id,
      appName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
      threadId: Id,
      turnId: Id,
      reason: Schema.String.check(Schema.isMaxLength(500)),
    }),
  ),
  /** Per-session consent for an F5-proxied provider integration (Codex Chrome / Sky). */
  chromeSession: Schema.optionalKey(
    Schema.Struct({ integration: Schema.Literals(["codex-chrome", "codex-computer"]) }),
  ),
  chromeSetup: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.Literals(["claude", "codex"]),
      previousTargets: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
        Schema.isMaxLength(32),
      ),
      targetPath: Schema.String.check(Schema.isMaxLength(4096)),
    }),
  ),
  apps: Schema.Array(
    Schema.Struct({
      appId: Id,
      name: Schema.String.check(Schema.isMaxLength(200)),
      tier: ComputerAppTier,
      warning: Schema.optional(Schema.Literal("browser")),
    }),
  ).check(Schema.isMaxLength(10)),
});
export type ComputerAccessRequested = typeof ComputerAccessRequested.Type;
export const ComputerAccessAnswer = Schema.Struct({
  requestId: Id,
  backendIncarnation: Id,
  decisions: Schema.Array(
    Schema.Struct({
      appId: Id,
      receipt: Schema.optionalKey(Id),
      allow: Schema.Boolean,
      allowTyping: Schema.Boolean,
      remember: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(10)),
  allowSessionActions: Schema.optional(Schema.Boolean),
  allowChromeSetup: Schema.optionalKey(Schema.Boolean),
  allowChromeSession: Schema.optionalKey(Schema.Boolean),
  allowForegroundTakeover: Schema.optionalKey(Schema.Boolean),
  /** Minted by Electron main only; renderer and model input never supply it. */
  sessionReceipt: Schema.optionalKey(Id),
});
export type ComputerAccessAnswer = typeof ComputerAccessAnswer.Type;
export const ComputerLeaseScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("foreground") }),
  Schema.Struct({ kind: Schema.Literal("app"), appId: Id }),
  Schema.Struct({ kind: Schema.Literal("takeover"), appId: Id, approvalReceipt: Id }),
]);
export type ComputerLeaseScope = typeof ComputerLeaseScope.Type;
export const ComputerLeaseHolder = Schema.Struct({
  ...ComputerAuthorization.fields,
  backend: ComputerBackendKind,
  threadTitle: Schema.String,
  /** Legacy peers send no scope; they only ever held the machine-wide foreground lease. */
  scope: ComputerLeaseScope.pipe(
    Schema.withDecodingDefault((): ComputerLeaseScope => ({ kind: "foreground" })),
  ),
  policyRevision: NonNegative.pipe(Schema.withDecodingDefault(() => 0)),
});
export type ComputerLeaseHolder = typeof ComputerLeaseHolder.Type;
export const ComputerExecutionState = Schema.Literals([
  "pending-consent",
  "waiting-idle",
  "active",
  "waiting-secure-input",
  "paused",
  "recovery",
]);
export type ComputerExecutionState = typeof ComputerExecutionState.Type;
export const ComputerPauseCause = Schema.Literals([
  "paused",
  "kill-switch",
  "user-input",
  "permit-expired",
  "target-active",
  "activation",
  "outcome-unknown",
  "access-changed",
]);
export type ComputerPauseCause = typeof ComputerPauseCause.Type;
export const ChromeLeaseHolder = Schema.Struct({
  profileId: Id,
  threadId: Id,
  sessionGeneration: Id,
  provider: Schema.Literals(["claude", "codex"]),
});
export type ChromeLeaseHolder = typeof ChromeLeaseHolder.Type;
export const ProviderIntegrationKind = Schema.Literals([
  "claude-chrome",
  "codex-chrome",
  "codex-computer",
]);
export type ProviderIntegrationKind = typeof ProviderIntegrationKind.Type;
/**
 * A provider-integration child (Claude CLI with Chrome, or an F5-proxied stdio server),
 * registered with desktop main before any stdio flows so main can stop it and observe
 * its exit even when the profile server is frozen.
 */
export const ChromeProcessRegistration = Schema.Struct({
  profileId: Id,
  backendIncarnation: Id,
  threadId: Id,
  sessionGeneration: Id,
  launchToken: Id,
  integration: ProviderIntegrationKind,
  pid: Positive,
  pgid: Positive,
  /** Epoch milliseconds when the backend spawned the process. */
  startTime: NonNegative,
});
export type ChromeProcessRegistration = typeof ChromeProcessRegistration.Type;
export const ChromeNativeHostTransactionState = Schema.Literals([
  "approved",
  "launched",
  "restoring",
  "partially-restored",
  "restored",
  "recovery-required",
]);
export type ChromeNativeHostTransactionState = typeof ChromeNativeHostTransactionState.Type;
export const ChromeNativeHostTransactionSummary = Schema.Struct({
  id: Id,
  provider: Schema.Literals(["claude", "codex"]),
  targetPath: Schema.String,
  createdAt: Schema.String,
  state: ChromeNativeHostTransactionState,
  /** Wrapper missing or its exec target gone: Restore is recommended. */
  stale: Schema.optionalKey(Schema.Boolean),
  legacy: Schema.optionalKey(Schema.Boolean),
  /** Newer unresolved setup that must be restored first. */
  blockedBy: Schema.optionalKey(Id),
  unresolved: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ChromeNativeHostTransactionSummary = typeof ChromeNativeHostTransactionSummary.Type;
export const ChromeNativeHostRestoreResult = Schema.Struct({
  restored: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String),
  unresolved: Schema.optionalKey(Schema.Array(Schema.String)),
  state: Schema.optionalKey(ChromeNativeHostTransactionState),
  /** Set when restore was refused before anything was stopped or written. */
  blockingTransactionId: Schema.optionalKey(Id),
  busy: Schema.optionalKey(Schema.Boolean),
  /** Main refused ownership for another reason (for example `recovery-required`). */
  failure: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type ChromeNativeHostRestoreResult = typeof ChromeNativeHostRestoreResult.Type;
export const ChromeReadinessEligibility = Schema.Literals([
  "off",
  "ready",
  "unavailable",
  "recovery-required",
]);
export const ChromeReadiness = Schema.Struct({
  providerInstanceId: Id,
  provider: Schema.Literals(["claude", "codex"]),
  eligibility: ChromeReadinessEligibility,
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  recordId: Schema.optionalKey(Id),
  checkedAt: Schema.String,
});
export type ChromeReadiness = typeof ChromeReadiness.Type;
export const ComputerToolOutcomeCode = Schema.Literals([
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
  "invalid-arguments",
  "app-resolution-failed",
  "fresh-screenshot-required",
  "display-required",
  "ForegroundRequired",
  "app-required",
]);
export type ComputerToolOutcomeCode = typeof ComputerToolOutcomeCode.Type;
export const COMPUTER_TAKEOVER_CONSENT_TIMEOUT_MS = 300_000;

export const ComputerActivity = Schema.Struct({
  source: Schema.optional(Schema.Literal("tool")),
  requestId: Schema.optionalKey(Id),
  sessionGeneration: Schema.optionalKey(Id),
  threadId: Id,
  backend: ComputerBackendKind,
  op: Id,
  status: Schema.Literals(["started", "completed", "failed", "interrupted"]),
  outcome: Schema.optional(ComputerToolOutcomeCode),
  appName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  thumbnailDataUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(40 * 1024))),
  delivery: Schema.optional(ComputerDelivery),
});
export type ComputerActivity = typeof ComputerActivity.Type;
export const SCHEDULED_NOTIFICATIONS_CAPABILITY = "scheduled-notifications-v1";
export const DesktopScheduledNotification = Schema.Struct({
  id: Id,
  title: Schema.String,
  body: Schema.String,
  taskId: Id,
  threadId: Schema.NullOr(Id),
});
export type DesktopScheduledNotification = typeof DesktopScheduledNotification.Type;
export const DesktopComputerHostMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("scheduledNotification"),
    notification: DesktopScheduledNotification,
  }),
  Schema.Struct({ type: Schema.Literal("scheduledNotificationAck"), id: Id }),
  Schema.Struct({
    /**
     * `chromeRestoreAcquire` takes the same exclusive lease for a storage-only restore. It
     * skips the launch certification gate, so history stays restorable after an SDK
     * upgrade or a withdrawn record.
     */
    type: Schema.Literals([
      "chromeLeaseAcquire",
      "chromeRestoreAcquire",
      "chromeLeaseRelease",
      "chromeLeaseValidate",
    ]),
    requestId: Id,
    holder: ChromeLeaseHolder,
  }),
  Schema.Struct({
    type: Schema.Literal("chromeLeaseChanged"),
    holder: Schema.NullOr(ChromeLeaseHolder),
    otherProfile: Schema.optionalKey(Schema.Boolean),
    /** Main could not observe a registered process exit; Chrome ownership is refused. */
    recoveryRequired: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("chromeProcessRegister"),
    requestId: Id,
    registration: ChromeProcessRegistration,
  }),
  Schema.Struct({ type: Schema.Literal("chromeProcessExited"), launchToken: Id }),
  // Built-in (provider-native) computer use holds the shared foreground lease per call.
  Schema.Struct({
    type: Schema.Literals(["builtinLeaseAcquire", "builtinLeaseValidate", "builtinLeaseRelease"]),
    requestId: Id,
    holder: ComputerLeaseHolder,
  }),
  Schema.Struct({ type: Schema.Literal("chromeInterrupted"), threadId: Id, sessionGeneration: Id }),
  Schema.Struct({
    type: Schema.Literal("hello"),
    profileId: Id,
    backendIncarnation: Id,
    protocolVersion: Schema.Literal(1),
    capabilities: Schema.optionalKey(Schema.Array(Id).check(Schema.isMaxLength(32))),
  }),
  // Desktop registration: sent only to backends that advertised a capability.
  Schema.Struct({
    type: Schema.Literal("hostCapabilities"),
    capabilities: Schema.Array(Id).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({ type: Schema.Literal("status"), status: ComputerAutomationBackendStatus }),
  Schema.Struct({ type: Schema.Literal("request"), request: ComputerAutomationRequest }),
  Schema.Struct({
    type: Schema.Literal("response"),
    requestId: Id,
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(ComputerAutomationError),
  }),
  Schema.Struct({ type: Schema.Literals(["cancel", "leaseAccepted"]), requestId: Id }),
  Schema.Struct({ type: Schema.Literal("grantForget"), projectId: Id, appId: Id }),
  Schema.Struct({
    type: Schema.Literal("grantsValidate"),
    requestId: Id,
    projectId: Id,
    grants: Schema.Array(ComputerGrant),
  }),
  Schema.Struct({
    type: Schema.Literals(["leaseAcquire", "leaseRelease"]),
    requestId: Id,
    holder: ComputerLeaseHolder,
  }),
  Schema.Struct({
    type: Schema.Literal("leaseChanged"),
    holder: Schema.NullOr(ComputerLeaseHolder),
    otherProfile: Schema.optionalKey(Schema.Boolean),
  }),
  // Capable peers only: every same-profile holder, other profiles stay anonymous.
  Schema.Struct({
    type: Schema.Literal("leasesChanged"),
    holders: Schema.Array(ComputerLeaseHolder).check(Schema.isMaxLength(64)),
    otherProfile: Schema.Boolean,
    pendingTakeover: Schema.optionalKey(Schema.Struct({ threadId: Id, appId: Id })),
  }),
  Schema.Struct({
    type: Schema.Literal("executionStateChanged"),
    threadId: Id,
    sessionGeneration: Id,
    state: Schema.NullOr(ComputerExecutionState),
    appId: Schema.optionalKey(Id),
    delivery: Schema.optionalKey(ComputerDelivery),
    pauseCause: Schema.optionalKey(ComputerPauseCause),
  }),
  Schema.Struct({
    type: Schema.Literal("foregroundTakeoverAcquire"),
    requestId: Id,
    approvalRequestId: Id,
    holder: ComputerLeaseHolder,
  }),
  Schema.Struct({
    type: Schema.Literal("observationInvalidate"),
    requestId: Id,
    threadId: Id,
    policyRevision: NonNegative,
  }),
  Schema.Struct({ type: Schema.Literal("pauseChanged"), threadId: Id, paused: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("resumeRequested"), threadId: Id }),
  Schema.Struct({ type: Schema.Literal("grantsChanged"), authorization: ComputerAuthorization }),
  Schema.Struct({ type: Schema.Literal("accessRequested"), request: ComputerAccessRequested }),
  Schema.Struct({ type: Schema.Literal("accessAnswer"), answer: ComputerAccessAnswer }),
  Schema.Struct({
    type: Schema.Literal("killSwitch"),
    threadId: Id,
    sessionGeneration: Id,
    turnId: Id,
  }),
  Schema.Struct({ type: Schema.Literal("physicalInput"), threadId: Id }),
  Schema.Struct({ type: Schema.Literal("activity"), activity: ComputerActivity }),
  Schema.Struct({
    type: Schema.Literal("heartbeat"),
    monitorHealthy: Schema.Boolean,
    suspended: Schema.Boolean,
  }),
]);
export type DesktopComputerHostMessage = typeof DesktopComputerHostMessage.Type;

/** User controls only. Execution and grant widening are never exposed over WebSocket. */
export interface DesktopComputerAutomationBridge {
  readonly status: () => Promise<ComputerAutomationBackendStatus>;
  readonly requestPermission: (kind: ComputerPermission) => Promise<void>;
  readonly openPermissionSettings: (kind: ComputerPermission) => Promise<void>;
  readonly retryHelper: () => Promise<void>;
  readonly answerAccess: (answer: ComputerAccessAnswer) => Promise<void>;
  readonly setPaused: (threadId: string, paused: boolean) => Promise<void>;
  readonly onStatus: (callback: (status: ComputerAutomationBackendStatus) => void) => () => void;
}
