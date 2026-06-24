import { Schema } from "effect";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { PreviewTabId } from "./preview";

const BoundedUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(60_000)),
);

export const PreviewAutomationOperation = Schema.Literals([
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
]);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

export const PreviewAutomationStatus = Schema.Struct({
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

export const PreviewAutomationOpenInput = Schema.Struct({
  url: Schema.optional(BoundedUrl),
  show: Schema.optional(Schema.Boolean),
  reuseExistingTab: Schema.optional(Schema.Boolean),
});
export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: BoundedUrl,
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-port"),
    port: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65_536)),
    protocol: Schema.optional(Schema.Literals(["http", "https"])),
    path: Schema.optional(Schema.String),
  }),
]);
export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  url: Schema.optional(BoundedUrl),
  target: Schema.optional(BrowserNavigationTarget),
  readiness: Schema.optional(Schema.Literals(["load", "domContentLoaded", "none"])),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      Number(input.url !== undefined) + Number(input.target !== undefined) === 1 ||
      "Provide exactly one of url or target.",
  ),
);
export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

const Locator = TrimmedNonEmptyString;
const LegacySelector = TrimmedNonEmptyString;

export const PreviewAutomationClickInput = Schema.Struct({
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter((input) => {
    const selectorModes =
      Number(input.selector !== undefined) + Number(input.locator !== undefined);
    const hasX = input.x !== undefined;
    const hasY = input.y !== undefined;
    if (hasX !== hasY) return "Coordinates require both x and y.";
    const coordinateModes = hasX && hasY ? 1 : 0;
    return selectorModes + coordinateModes === 1 || "Provide exactly one click target.";
  }),
);
export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  text: Schema.String,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  clear: Schema.optional(Schema.Boolean),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.selector !== undefined && input.locator !== undefined) ||
      "Provide at most one of selector or locator.",
  ),
);
export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  key: TrimmedNonEmptyString,
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
});
export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
}).check(
  Schema.makeFilter((input) => {
    if (input.selector !== undefined && input.locator !== undefined) {
      return "Provide at most one of selector or locator.";
    }
    return input.deltaX !== undefined || input.deltaY !== undefined || "Provide deltaX or deltaY.";
  }),
);
export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  expression: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  awaitPromise: Schema.optional(Schema.Boolean),
  timeoutMs: OptionalTimeoutMs,
});
export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;

export const PreviewAutomationWaitForInput = Schema.Struct({
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  text: Schema.optional(TrimmedNonEmptyString),
  urlIncludes: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter((input) => {
    if (input.selector !== undefined && input.locator !== undefined) {
      return "Provide at most one of selector or locator.";
    }
    return (
      input.selector !== undefined ||
      input.locator !== undefined ||
      input.text !== undefined ||
      input.urlIncludes !== undefined ||
      "Provide at least one wait condition."
    );
  }),
);
export type PreviewAutomationWaitForInput = typeof PreviewAutomationWaitForInput.Type;

export const PreviewAutomationElement = Schema.Struct({
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  selector: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type PreviewAutomationElement = typeof PreviewAutomationElement.Type;

export const PreviewAutomationConsoleEntry = Schema.Struct({
  level: Schema.String,
  text: Schema.String,
  timestamp: Schema.String,
  source: Schema.optional(Schema.String),
});
export type PreviewAutomationConsoleEntry = typeof PreviewAutomationConsoleEntry.Type;

export const PreviewAutomationNetworkEntry = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  status: Schema.NullOr(Schema.Number),
  failed: Schema.Boolean,
  errorText: Schema.optional(Schema.String),
  timestamp: Schema.String,
});
export type PreviewAutomationNetworkEntry = typeof PreviewAutomationNetworkEntry.Type;

export const PreviewAutomationActionEvent = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed", "interrupted"]),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PreviewAutomationActionEvent = typeof PreviewAutomationActionEvent.Type;

export const PreviewAutomationSnapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  visibleText: Schema.String,
  interactiveElements: Schema.Array(PreviewAutomationElement),
  accessibilityTree: Schema.Unknown,
  consoleEntries: Schema.Array(PreviewAutomationConsoleEntry),
  networkEntries: Schema.Array(PreviewAutomationNetworkEntry),
  actionTimeline: Schema.Array(PreviewAutomationActionEvent),
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshot.Type;

export const PreviewAutomationOwner = Schema.Struct({
  clientId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.NullOr(PreviewTabId),
  visible: Schema.Boolean,
  supportsAutomation: Schema.Boolean,
  focusedAt: Schema.String,
});
export type PreviewAutomationOwner = typeof PreviewAutomationOwner.Type;

export const PreviewAutomationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
  operation: PreviewAutomationOperation,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewAutomationRequest = typeof PreviewAutomationRequest.Type;

export const PreviewAutomationResponse = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      _tag: TrimmedNonEmptyString,
      message: Schema.String,
      detail: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type PreviewAutomationResponse = typeof PreviewAutomationResponse.Type;

export const PreviewAutomationClearOwnerInput = Schema.Struct({
  clientId: TrimmedNonEmptyString,
});
export type PreviewAutomationClearOwnerInput = typeof PreviewAutomationClearOwnerInput.Type;

export class PreviewAutomationUnavailableError extends Schema.TaggedErrorClass<PreviewAutomationUnavailableError>()(
  "PreviewAutomationUnavailableError",
  { message: Schema.String },
) {}

export class PreviewAutomationNoFocusedOwnerError extends Schema.TaggedErrorClass<PreviewAutomationNoFocusedOwnerError>()(
  "PreviewAutomationNoFocusedOwnerError",
  { message: Schema.String },
) {}

export class PreviewAutomationUnsupportedClientError extends Schema.TaggedErrorClass<PreviewAutomationUnsupportedClientError>()(
  "PreviewAutomationUnsupportedClientError",
  { message: Schema.String },
) {}

export class PreviewAutomationTabNotFoundError extends Schema.TaggedErrorClass<PreviewAutomationTabNotFoundError>()(
  "PreviewAutomationTabNotFoundError",
  { message: Schema.String },
) {}

export class PreviewAutomationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  { message: Schema.String },
) {}

export class PreviewAutomationControlInterruptedError extends Schema.TaggedErrorClass<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  { message: Schema.String },
) {}

export class PreviewAutomationExecutionError extends Schema.TaggedErrorClass<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  { message: Schema.String, detail: Schema.optional(Schema.Unknown) },
) {}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedErrorClass<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  { message: Schema.String, selector: Schema.String },
) {}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedErrorClass<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  { message: Schema.String, maximumBytes: Schema.Int },
) {}

export const PreviewAutomationError = Schema.Union([
  PreviewAutomationUnavailableError,
  PreviewAutomationNoFocusedOwnerError,
  PreviewAutomationUnsupportedClientError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
]);
export type PreviewAutomationError = typeof PreviewAutomationError.Type;
