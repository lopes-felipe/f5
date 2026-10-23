import { Schema } from "effect";
import type { SessionNotification } from "effect-acp/schema";

export const COPILOT_ACP_SESSION_EVENT = "github.com/copilot/sessionEvent";
const META = "github.com/copilot";
export const copilotAcpCapabilities = {
  [META]: {
    events: [
      "subagent.started",
      "subagent.completed",
      "subagent.failed",
      "assistant.message_delta",
      "assistant.reasoning_delta",
    ],
  },
};
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
export const CopilotAcpSessionEvent = Schema.Struct({
  sessionId: id,
  type: Schema.String.check(Schema.isMaxLength(128)),
  agentId: Schema.optional(id),
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type RawEvent = typeof CopilotAcpSessionEvent.Type;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const boundedId = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : undefined;

export const isCopilotAcpCommand = (command: string): boolean =>
  /^copilot(?:\.exe|\.cmd)?$/iu.test(command.split(/[/\\]/u).at(-1) ?? "");

/** Raw attribution and ACP updates arrive on the same ordered protocol reader. */
export function makeCopilotAcpRouting() {
  type State = {
    delta: { kind: string; text: string; private: boolean } | undefined;
    tasks: Map<string, string>;
    active: Set<string>;
    overflowed: boolean;
  };
  const sessions = new Map<string, State>();
  let overflowed = false;
  const onEvent = (event: RawEvent) => {
    let state = sessions.get(event.sessionId);
    if (!state) {
      if (sessions.size >= 64) {
        overflowed = true;
        return;
      }
      state = { delta: undefined, tasks: new Map(), active: new Set(), overflowed: false };
      sessions.set(event.sessionId, state);
    }
    const data = event.data ?? {};
    switch (event.type) {
      case "assistant.message_delta":
      case "assistant.reasoning_delta": {
        state.delta = undefined;
        if (typeof data.deltaContent !== "string" || data.deltaContent.length > 131072) return;
        state.delta = {
          kind: event.type,
          text: data.deltaContent,
          private: data.parentToolCallId !== undefined && data.parentToolCallId !== null,
        };
        return;
      }
      case "subagent.started": {
        const task = boundedId(data.toolCallId);
        if (!event.agentId || !task) return;
        state.tasks.delete(event.agentId);
        state.tasks.set(event.agentId, task);
        state.active.add(event.agentId);
        if (state.tasks.size > 256) {
          state.overflowed = true;
          const oldest = state.tasks.keys().next().value!;
          state.tasks.delete(oldest);
          state.active.delete(oldest);
        }
        return;
      }
      case "subagent.completed":
      case "subagent.failed":
        if (event.agentId) state.active.delete(event.agentId);
        // Retain bounded identities so late child tool updates stay private.
        return;
    }
  };
  const normalize = (notification: SessionNotification): SessionNotification | undefined => {
    const state = sessions.get(String(notification.sessionId));
    const update = notification.update;
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk"
    ) {
      const delta = state?.delta;
      if (state) state.delta = undefined;
      const kind =
        update.sessionUpdate === "agent_message_chunk"
          ? "assistant.message_delta"
          : "assistant.reasoning_delta";
      const matched =
        delta?.kind === kind &&
        update.content.type === "text" &&
        delta.text === update.content.text;
      if (matched) return delta.private ? undefined : notification;
      // An unmatched chunk cannot prove parent ownership while a child is active.
      return delta?.private || state?.active.size || state?.overflowed || overflowed
        ? undefined
        : notification;
    }
    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const agentId = boundedId(record(record(update._meta)?.[META])?.agentId);
      if (agentId && (state?.tasks.has(agentId) || state?.overflowed || overflowed))
        return undefined;
    }
    return notification;
  };
  return {
    onEvent,
    normalize,
    clear: () => {
      sessions.clear();
      overflowed = false;
    },
  };
}
