/**
 * Pinned Muse Session Protocol (MSP) surface F5 was written against.
 *
 * `@muse-code/sdk` versions in lockstep with the Muse Code CLI, so both pins
 * move together. `scripts/audit-muse-protocol.ts` (`bun run
 * protocol:audit:muse`) fails when the installed SDK, its bundled wire
 * declarations, or its schema fingerprint drift from these values.
 *
 * This is Muse Code (Meta's coding CLI), not the Muse personal agent, which
 * has no public API.
 */
export const MUSE_CLI_BASELINE_VERSION = "1.4.8" as const;
export const MUSE_SDK_VERSION = "1.4.8" as const;

/** `InitializeResult.schema.fingerprint` the pinned SDK expects. */
export const MUSE_EXPECTED_SCHEMA_FINGERPRINT =
  "sha256:4e3200c3c9dc0cd7919d11022630d43f9bc1c5cdda375381e90b0183b5665069" as const;

/** sha256 of the SDK's bundled stable `msp.d.ts`. */
export const MUSE_WIRE_DECLARATIONS_SHA256 =
  "3fcc708c4e28f426797564946c1a066c2043050866fc3b0a3122f79c9f744997" as const;

/**
 * Server arguments F5 always passes. F5 never passes `--yolo`,
 * `--disable-approval` or `--disable-sandbox`.
 */
export const MUSE_SERVE_ARGS = ["serve", "--approval-judge", "off"] as const;
export const MUSE_FORBIDDEN_ARGS = ["--yolo", "--disable-approval", "--disable-sandbox"] as const;

/**
 * Permission profile used for text generation. MSP 1.4 exposes no profile
 * catalog, so the id is pinned here and proven applied through the SDK's
 * `requirePermissionProfile` read-back; the live audit confirms it.
 */
export const MUSE_READ_ONLY_PERMISSION_PROFILE = "read-only" as const;

/** MSP approval mode F5 requests, per F5 runtime mode. */
export const MUSE_APPROVAL_MODE_BY_RUNTIME_MODE = {
  "auto-accept-edits": "promptUnmatched",
  "full-access": "allowAll",
} as const;

export const MUSE_PROTOCOL_DISPOSITIONS = [
  "canonical",
  "state-only",
  "diagnostics-only",
  "unsupported",
] as const;
export type MuseProtocolDisposition = (typeof MUSE_PROTOCOL_DISPOSITIONS)[number];

/** Every stable MSP notification, with how F5 treats it. */
export const MUSE_NOTIFICATION_DISPOSITIONS = {
  initialized: "state-only",
  "session/started": "state-only",
  "session/closed": "canonical",
  "skill/changed": "unsupported",
  "turn/started": "canonical",
  "turn/completed": "canonical",
  "turn/retracted": "canonical",
  "turn/retryScheduled": "canonical",
  "turn/modelRetryScheduled": "canonical",
  "turn/unqueued": "state-only",
  "turn/foregroundCompleted": "state-only",
  "item/started": "canonical",
  "item/updated": "canonical",
  "item/delta": "canonical",
  "item/completed": "canonical",
  "view/gap": "state-only",
  "approval/requested": "canonical",
  "approval/updated": "canonical",
  "approval/resolved": "canonical",
  "userInput/requested": "canonical",
  "userInput/settled": "canonical",
  "userInput/engaged": "diagnostics-only",
  "session/modelChanged": "state-only",
  "session/reasoningEffortChanged": "state-only",
  "session/statusChanged": "state-only",
  "session/goalChanged": "unsupported",
  "session/todoListChanged": "canonical",
  "session/branchChanged": "diagnostics-only",
  "session/tokenUsage": "canonical",
  "session/contextUsage": "canonical",
  "session/approvalModeChanged": "canonical",
  "recap/completed": "unsupported",
  "session/modelRouteUnserved": "canonical",
  "session/nameChanged": "diagnostics-only",
  "session/viewHealthChanged": "diagnostics-only",
  "session/listChanged": "unsupported",
  "usage/changed": "canonical",
  "computerUseSetup/changed": "unsupported",
  "plugin/changed": "unsupported",
  "plugin/marketplaceChanged": "unsupported",
} as const satisfies Record<string, MuseProtocolDisposition>;

/** Client requests F5 sends. Anything else in the stable surface is unused. */
export const MUSE_CLIENT_METHODS_USED = [
  "initialize",
  "session/start",
  "session/resume",
  "session/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "turn/cancel",
  "session/setModel",
  "session/setReasoningEffort",
  "session/setApprovalMode",
  "model/list",
  "view/subscribe",
  "view/page",
  "approval/decide",
  "approval/listPending",
  "userInput/answer",
  "userInput/cancel",
  "usage/read",
] as const;

/** Server requests; MSP 1.4 delivers both through notifications instead. */
export const MUSE_SERVER_REQUEST_DISPOSITIONS = {
  "approval/request": "unsupported",
  "userInput/request": "unsupported",
} as const satisfies Record<string, MuseProtocolDisposition>;
