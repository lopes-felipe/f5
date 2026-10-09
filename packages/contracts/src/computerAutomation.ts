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
export const ComputerAutomationBackendStatus = Schema.Union([
  Schema.Struct({
    available: Schema.Literal(true),
    displays: Schema.optional(Schema.Array(ComputerDisplay)),
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
const Envelope = {
  requestId: Id,
  payloadHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  authorization: ComputerAuthorization,
  deadlineAtMs: Positive,
  agent: Schema.Struct({
    provider: Schema.Literals(["claude", "codex"]),
    threadTitle: Schema.String.check(Schema.isMaxLength(200)),
  }),
  screenshot: Schema.optional(Schema.Boolean),
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
  Schema.Struct({ ...Envelope, op: Schema.Literal("screenshot"), displayId: Schema.optional(Id) }),
  Schema.Struct({ ...Envelope, op: Schema.Literal("zoom"), displayId: Id, rect: Rect }),
  Schema.Struct({
    ...Envelope,
    op: Schema.Literal("inspect"),
    appId: Id,
    maxNodes: Positive.check(Schema.isLessThanOrEqualTo(400)),
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
export const ComputerScreenshot = Schema.Struct({
  displayId: Id,
  geometryGeneration: Id,
  modelSize: Size,
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String.check(Schema.isMaxLength(8 * 1024 * 1024)),
  hiddenContent: Schema.Boolean,
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
});
export type ComputerActionResult = typeof ComputerActionResult.Type;
export const ComputerInspectResult = Schema.Struct({
  snapshotId: Id,
  appId: Id,
  accessible: Schema.Boolean,
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
  ).check(Schema.isMaxLength(400)),
});
export type ComputerInspectResult = typeof ComputerInspectResult.Type;
export const ComputerAutomationError = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Unavailable"),
    reason: ComputerAutomationUnavailableReason,
    missing: Schema.optional(Schema.Array(ComputerPermission)),
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
      "turn-ended",
      "permit-expired",
    ]),
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
    ]),
  }),
  Schema.Struct({ _tag: Schema.Literal("Execution"), message: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literals([
      "OutcomeUnknown",
      "GeometryChanged",
      "StaleElement",
      "UnsupportedAction",
      "ReplayRejected",
      "PayloadMismatch",
      "ResultTooLarge",
    ]),
  }),
]);
export type ComputerAutomationError = typeof ComputerAutomationError.Type;
export const ComputerAccessRequested = Schema.Struct({
  requestId: Id,
  threadId: Id,
  reason: Schema.String.check(Schema.isMaxLength(500)),
  kind: Schema.Literals(["apps", "session-actions"]),
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
      allow: Schema.Boolean,
      allowTyping: Schema.Boolean,
      remember: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(10)),
  allowSessionActions: Schema.optional(Schema.Boolean),
});
export type ComputerAccessAnswer = typeof ComputerAccessAnswer.Type;
export const ComputerLeaseHolder = Schema.Struct({
  ...ComputerAuthorization.fields,
  backend: ComputerBackendKind,
  threadTitle: Schema.String,
});
export type ComputerLeaseHolder = typeof ComputerLeaseHolder.Type;
export const ComputerActivity = Schema.Struct({
  threadId: Id,
  backend: ComputerBackendKind,
  op: Id,
  status: Schema.Literals(["started", "completed", "failed", "interrupted"]),
  appName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  thumbnailDataUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(40 * 1024))),
});
export type ComputerActivity = typeof ComputerActivity.Type;
export const DesktopComputerHostMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hello"),
    profileId: Id,
    backendIncarnation: Id,
    protocolVersion: Schema.Literal(1),
  }),
  Schema.Struct({ type: Schema.Literal("status"), status: ComputerAutomationBackendStatus }),
  Schema.Struct({ type: Schema.Literal("request"), request: ComputerAutomationRequest }),
  Schema.Struct({
    type: Schema.Literal("response"),
    requestId: Id,
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(ComputerAutomationError),
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), requestId: Id }),
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
