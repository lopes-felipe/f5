import { Schema } from "effect";

export const MOBILE_API_VERSION = 1;
export const MOBILE_ROOT = "/mobile/v1";
export const MOBILE_CLOSE = { revoked: 4401, disabled: 4403, upgradeRequired: 4426 } as const;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OptionalId = Schema.NullOr(Id);
export const MobileApiWindow = Schema.Struct({ min: Sequence, current: Sequence });
export const MobileStatus = Schema.Struct({
  serverId: Id,
  serverVersion: Id,
  mobileApi: MobileApiWindow,
});
export const MobilePairRequest = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[A-Z2-7]{10}$/)),
  deviceName: Id,
  platform: Schema.Literals(["ios", "android"]),
  appVersion: Id,
  bundleId: Id,
});
export const MobilePairResponse = Schema.Struct({
  ...MobileStatus.fields,
  deviceId: Id,
  deviceToken: Schema.String,
  profileName: Schema.String,
});
export const MobileBootstrap = Schema.Struct({
  ...MobileStatus.fields,
  profileName: Schema.String,
  backendIncarnation: Id,
  ready: Schema.Boolean,
  health: Schema.Literals(["ok", "degraded"]),
  attachmentLimits: Schema.Struct({
    maxCount: Schema.Int,
    maxImageBytes: Schema.Int,
    maxImagesBytes: Schema.Int,
  }),
});
export const MobileThreadShell = Schema.Struct({
  id: Id,
  projectId: OptionalId,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  latestActivityAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  snoozedUntil: Schema.NullOr(Schema.String),
  settledAt: Schema.NullOr(Schema.String),
  interactionMode: Schema.String,
  runtimeMode: Schema.String,
  sessionStatus: Schema.NullOr(Schema.String),
  activeTurnId: OptionalId,
  latestTurn: Schema.NullOr(
    Schema.Struct({
      turnId: Id,
      state: Schema.String,
      completedAt: Schema.NullOr(Schema.String),
    }),
  ),
  workflowRole: Schema.NullOr(Schema.String),
  isSideChat: Schema.Boolean,
  attention: Schema.Struct({
    pendingApprovalRequestIds: Schema.Array(Id),
    pendingInputRequestIds: Schema.Array(Id),
    planReady: Schema.Boolean,
    latestFailedTurnId: OptionalId,
    latestCompletedTurnId: OptionalId,
  }),
});
export const MobileShell = Schema.Struct({
  snapshotSequence: Sequence,
  backendIncarnation: Id,
  projects: Schema.Array(Schema.Struct({ id: Id, name: Schema.String })),
  threads: Schema.Array(MobileThreadShell),
});
export const MobileMessage = Schema.Struct({
  messageId: Id,
  role: Schema.String,
  text: Schema.String,
  streaming: Schema.Boolean,
  createdAt: Schema.String,
});
export const MobileApproval = Schema.Struct({
  requestId: Id,
  kind: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  decisionReason: Schema.optionalKey(Schema.String),
  defaultToNo: Schema.optionalKey(Schema.Boolean),
  decisions: Schema.Array(Schema.Literals(["accept", "decline", "cancel"])),
});
export const MobileQuestion = Schema.Struct({
  id: Id,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      value: Schema.optionalKey(Schema.String),
    }),
  ),
  optional: Schema.optionalKey(Schema.Boolean),
  multiSelect: Schema.optionalKey(Schema.Boolean),
  allowCustomAnswer: Schema.optionalKey(Schema.Boolean),
  initialAnswer: Schema.optionalKey(Schema.String),
});
export const MobilePendingInput = Schema.Struct({
  requestId: Id,
  hostOnly: Schema.Boolean,
  responseMode: Schema.Literals(["native", "message"]),
  questions: Schema.Array(MobileQuestion),
});
export const MobileThreadTail = Schema.Struct({
  snapshotSequence: Sequence,
  hasOlderMessages: Schema.optionalKey(Schema.Boolean),
  messages: Schema.Array(MobileMessage),
  approvals: Schema.Array(MobileApproval),
  pendingInputs: Schema.Array(MobilePendingInput),
  plan: Schema.NullOr(Schema.String),
  activity: Schema.Array(
    Schema.Struct({
      id: Id,
      createdAt: Schema.String,
      kind: Schema.String,
      summary: Schema.String,
    }),
  ),
});
export const MobileMessagePatch = Schema.Struct({
  ...MobileMessage.fields,
  sequence: Sequence,
  mode: Schema.Literals(["append", "replace"]),
  completed: Schema.Boolean,
});
export const MobileBatch = Schema.Struct({
  afterSequence: Sequence,
  throughSequence: Sequence,
  threadIds: Schema.Array(Id),
  projectsChanged: Schema.Boolean,
  selectedThreadId: OptionalId,
  messages: Schema.Array(MobileMessagePatch),
  tailInvalidated: Schema.Boolean,
  transcriptReset: Schema.Boolean,
});
export const MobileNotificationPrefs = Schema.Struct({
  approval: Schema.Boolean,
  input: Schema.Boolean,
  failed: Schema.Boolean,
  "plan-ready": Schema.Boolean,
  completed: Schema.Boolean,
  previews: Schema.Boolean,
});
export type MobileNotificationPrefs = typeof MobileNotificationPrefs.Type;
export const MobileErrorCode = Schema.Literals([
  "busy",
  "starting",
  "stale-action",
  "invalid-request",
  "workspace-unavailable",
  "forbidden",
  "host-only",
  "rejected",
]);
export type MobileErrorCode = typeof MobileErrorCode.Type;

const Thread = { threadId: Id };
const Decision = { ...Thread, requestId: Id };
const PageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));
export const mobileMethods = {
  subscribe: Schema.Struct({
    selectedThreadId: OptionalId,
    resume: Schema.optionalKey(Schema.Struct({ afterSequence: Sequence, backendIncarnation: Id })),
  }),
  probe: Schema.Struct({}),
  getThreadShells: Schema.Struct({ threadIds: Schema.Array(Id).check(Schema.isMaxLength(256)) }),
  getThreadTail: Schema.Struct({ ...Thread, messageLimit: PageSize }),
  getThreadHistory: Schema.Struct({
    ...Thread,
    cursor: Schema.Struct({ createdAt: Id, messageId: Id }),
    limit: PageSize,
  }),
  getCommandExecution: Schema.Struct({ ...Thread, id: Id }),
  respondToApproval: Schema.Struct({
    ...Decision,
    decision: Schema.Literals(["accept", "decline", "cancel"]),
  }),
  respondToQuestion: Schema.Struct({
    ...Decision,
    answers: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    ),
  }),
  dismissQuestion: Schema.Struct(Decision),
  interrupt: Schema.Struct({ ...Thread, turnId: Id }),
  settle: Schema.Struct(Thread),
  unsettle: Schema.Struct(Thread),
  snooze: Schema.Struct({ ...Thread, until: Id }),
  unsnooze: Schema.Struct(Thread),
  archive: Schema.Struct(Thread),
  registerPush: Schema.Struct({
    pushToken: Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32,256}$/)),
    environment: Schema.Literals(["sandbox", "production"]),
    bundleId: Id,
  }),
  setPresence: Schema.Struct({ foreground: Schema.Boolean, viewingThreadId: OptionalId }),
  setNotificationPrefs: MobileNotificationPrefs,
  unregisterPush: Schema.Struct({}),
} as const;
export const MobileRequestEnvelope = Schema.Struct({ id: Id, method: Id, body: Schema.Unknown });
export const MobileSubscribeResult = Schema.Struct({
  head: Sequence,
  snapshotRequired: Schema.Boolean,
  batches: Schema.Array(MobileBatch),
});
export const MobileHistory = Schema.Struct({
  snapshotSequence: Sequence,
  messages: Schema.Array(MobileMessage),
  cursor: Schema.NullOr(Schema.Struct({ createdAt: Id, messageId: Id })),
});
export const MobileCommandExecution = Schema.NullOr(
  Schema.Struct({
    id: Id,
    title: Schema.String,
    status: Schema.String,
    output: Schema.String,
    truncated: Schema.Boolean,
  }),
);

const SequenceReceipt = Schema.Struct({ sequence: Sequence });
export const mobileResults = {
  subscribe: MobileSubscribeResult,
  probe: MobileBootstrap,
  getThreadShells: MobileShell,
  getThreadTail: MobileThreadTail,
  getThreadHistory: MobileHistory,
  getCommandExecution: MobileCommandExecution,
  respondToApproval: SequenceReceipt,
  respondToQuestion: SequenceReceipt,
  dismissQuestion: SequenceReceipt,
  interrupt: SequenceReceipt,
  settle: SequenceReceipt,
  unsettle: SequenceReceipt,
  snooze: SequenceReceipt,
  unsnooze: SequenceReceipt,
  archive: SequenceReceipt,
  registerPush: Schema.Struct({ registered: Schema.Literal(true) }),
  setPresence: Schema.Struct({ updated: Schema.Literal(true) }),
  setNotificationPrefs: Schema.Struct({ updated: Schema.Literal(true) }),
  unregisterPush: Schema.Struct({ updated: Schema.Literal(true) }),
} satisfies Record<keyof typeof mobileMethods, Schema.Top>;

// Main listener only.
export const MobileAccessStatus = Schema.Struct({
  state: Schema.Literals(["off", "listening", "waiting-for-tailscale", "error"]),
  apnsKeyStored: Schema.optionalKey(Schema.Boolean),
  address: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(Schema.Int),
  magicDnsName: Schema.optionalKey(Schema.String),
  detection: Schema.optionalKey(Schema.Literals(["cli", "heuristic"])),
  requiresConfirmation: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(Schema.String),
});
export type MobileAccessStatus = typeof MobileAccessStatus.Type;
export const MobileDeviceId = Schema.Struct({ deviceId: Id });
export const MobileDeviceName = Schema.Struct({ deviceId: Id, name: Id });
export const MobileAccessEnabled = Schema.Struct({ enabled: Schema.Boolean });
export const MobileInterfaceConfirmation = Schema.Struct({ address: Id });
export const MobileApnsUpdate = Schema.Struct({
  teamId: Id,
  keyId: Id,
  baseBundleId: Id,
  privateKey: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
});
export interface MobilePairingCode {
  readonly code: string;
  readonly url: string;
  readonly expiresAt: number;
}
export interface MobileDeviceSummary {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly pushRegistered: boolean;
}
