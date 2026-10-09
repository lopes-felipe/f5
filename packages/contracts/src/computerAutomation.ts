import { Schema } from "effect";

/**
 * F5-native computer control (screen capture plus synthesized input) driven by the
 * desktop app. The backend ships disabled: it reports `available: true` only after
 * it passes the certification gate in docs/agent-browser.md, and no agent tool is
 * installed until it does.
 */
export const ComputerAutomationUnavailableReason = Schema.Literals([
  "not-certified",
  "unsupported-platform",
  "missing-permissions",
  "disabled",
]);
export type ComputerAutomationUnavailableReason = typeof ComputerAutomationUnavailableReason.Type;

export const ComputerAutomationBackendStatus = Schema.Union([
  Schema.Struct({ available: Schema.Literal(true) }),
  Schema.Struct({
    available: Schema.Literal(false),
    reason: ComputerAutomationUnavailableReason,
    detail: Schema.optional(Schema.String),
  }),
]);
export type ComputerAutomationBackendStatus = typeof ComputerAutomationBackendStatus.Type;

const ScreenCoordinate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ComputerAutomationClickInput = Schema.Struct({
  x: ScreenCoordinate,
  y: ScreenCoordinate,
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
  clickCount: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3)),
  ),
});
export type ComputerAutomationClickInput = typeof ComputerAutomationClickInput.Type;

export const ComputerAutomationTypeInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(10_000)),
});
export type ComputerAutomationTypeInput = typeof ComputerAutomationTypeInput.Type;

export const ComputerAutomationKeyInput = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
});
export type ComputerAutomationKeyInput = typeof ComputerAutomationKeyInput.Type;

export const ComputerAutomationScrollInput = Schema.Struct({
  x: ScreenCoordinate,
  y: ScreenCoordinate,
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
});
export type ComputerAutomationScrollInput = typeof ComputerAutomationScrollInput.Type;

export const ComputerAutomationScreenshot = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  /** Screen points per screenshot pixel, so coordinates map back to the display. */
  scale: Schema.Finite,
});
export type ComputerAutomationScreenshot = typeof ComputerAutomationScreenshot.Type;

/** Desktop bridge surface. Only `status` is implemented until the backend is certified. */
export interface DesktopComputerAutomationBridge {
  readonly status: () => Promise<ComputerAutomationBackendStatus>;
}
