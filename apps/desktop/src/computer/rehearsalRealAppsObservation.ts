import { Schema } from "effect";
import { isComputerMutation } from "@t3tools/shared/computerControl";
import {
  ComputerActionResult,
  ComputerInspectResult,
  DesktopComputerHostMessage,
  type ComputerAutomationRequest,
} from "@t3tools/contracts";

export const REAL_APP_REHEARSAL_IDS = ["com.apple.TextEdit", "com.apple.calculator"] as const;
export const REAL_APP_REHEARSAL_TEXT = "F5_REAL_APP_REHEARSAL Ω🙂";
type AppKind = "textEdit" | "calculator";
const appKind = (appId: string | undefined): AppKind | undefined =>
  appId === REAL_APP_REHEARSAL_IDS[0]
    ? "textEdit"
    : appId === REAL_APP_REHEARSAL_IDS[1]
      ? "calculator"
      : undefined;

/** Correlated real-app outcomes only. Never retains text, keys, accessibility
 * content, images, app names or arbitrary errors from the native channel. */
export class RehearsalRealAppsObservation {
  private readonly admitted = new Set<string>();
  private readonly pending = new Map<
    string,
    {
      op: ComputerAutomationRequest["op"];
      app?: AppKind;
      explicitApp: boolean;
      press: boolean;
      expectedText: boolean;
      selectAll: boolean;
      save: boolean;
    }
  >();
  private textEditInspected = false;
  private calculatorInspected = false;
  private textEditTyping = false;
  private textEditKeys = 0;
  private expectedTextTyping = false;
  private selectAllKeySucceeded = false;
  private saveKeySucceeded = false;
  private calculatorOpened = false;
  private calculatorPresses = 0;
  private unexpectedAppInput = false;
  private failedMutations = 0;
  private ambiguousMutations = 0;
  private observationFailures = 0;
  private typingRequests = 0;
  private invalidResponses = 0;
  private overflow = false;
  constructor(private readonly threadId: string) {}
  receive(raw: unknown): void {
    if (!Schema.is(DesktopComputerHostMessage)(raw)) return;
    if (raw.type === "request" && raw.request.authorization.threadId === this.threadId) {
      const request = raw.request;
      if (this.admitted.has(request.requestId)) return;
      if (this.admitted.size >= 128) {
        this.overflow = true;
        return;
      }
      this.admitted.add(request.requestId);
      if (request.op === "type") this.typingRequests++;
      const app = "appId" in request ? appKind(request.appId) : undefined;
      this.pending.set(request.requestId, {
        op: request.op,
        ...(app ? { app } : {}),
        explicitApp: "appId" in request,
        press: request.op === "elementAction" && request.action === "press",
        expectedText: request.op === "type" && request.text === REAL_APP_REHEARSAL_TEXT,
        selectAll:
          request.op === "key" &&
          request.chords.length === 1 &&
          request.repeat === 1 &&
          /^(cmd|command|meta)\+a$/i.test(request.chords[0]!),
        save:
          request.op === "key" &&
          request.chords.length === 1 &&
          request.repeat === 1 &&
          /^(cmd|command|meta)\+s$/i.test(request.chords[0]!),
      });
    } else if (raw.type === "response") {
      const request = this.pending.get(raw.requestId);
      if (!request) return;
      this.pending.delete(raw.requestId);
      if (raw.error !== undefined) {
        if (isComputerMutation(request.op)) {
          this.failedMutations++;
          if (raw.error._tag === "OutcomeUnknown") this.ambiguousMutations++;
        } else this.observationFailures++;
        return;
      }
      const result = raw.result;
      if (
        request.op === "inspect" &&
        Schema.is(ComputerInspectResult)(result) &&
        result.accessible &&
        result.nodes.length &&
        appKind(result.appId) === request.app
      ) {
        if (request.app === "textEdit") this.textEditInspected = true;
        if (request.app === "calculator") this.calculatorInspected = true;
      } else if (
        isComputerMutation(request.op) &&
        Schema.is(ComputerActionResult)(result) &&
        result.actionCompleted !== false
      ) {
        const app = appKind(result.frontmostApp?.appId);
        if (!app || (request.explicitApp && request.app !== app)) {
          this.unexpectedAppInput = true;
          return;
        }
        if (request.op === "type" && app === "textEdit") {
          this.textEditTyping = true;
          this.expectedTextTyping ||= request.expectedText;
        }
        if (request.op === "key" && app === "textEdit") {
          this.textEditKeys++;
          this.selectAllKeySucceeded ||= request.selectAll;
          this.saveKeySucceeded ||= request.save;
        }
        if (request.op === "openApp" && app === "calculator") this.calculatorOpened = true;
        if (request.press && app === "calculator") this.calculatorPresses++;
      } else if (
        isComputerMutation(request.op) ||
        (request.op === "inspect" &&
          (!Schema.is(ComputerInspectResult)(result) || appKind(result.appId) !== request.app))
      ) {
        this.invalidResponses++;
      }
    }
  }
  snapshot() {
    return {
      textEditInspected: this.textEditInspected,
      calculatorInspected: this.calculatorInspected,
      textEditTyping: this.textEditTyping,
      textEditKeys: this.textEditKeys,
      expectedTextTyping: this.expectedTextTyping,
      selectAllKeySucceeded: this.selectAllKeySucceeded,
      saveKeySucceeded: this.saveKeySucceeded,
      calculatorOpened: this.calculatorOpened,
      calculatorPresses: this.calculatorPresses,
      unexpectedAppInput: this.unexpectedAppInput,
      failedMutations: this.failedMutations,
      ambiguousMutations: this.ambiguousMutations,
      observationFailures: this.observationFailures,
      typingRequests: this.typingRequests,
      traceComplete: !this.overflow && this.pending.size === 0 && this.invalidResponses === 0,
    };
  }
}
