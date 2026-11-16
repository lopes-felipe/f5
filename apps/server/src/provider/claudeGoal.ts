import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeNativeGoal {
  readonly objective: string;
  readonly status: "active" | "complete";
  readonly checks: number;
  readonly lastCheck?: string;
}

/** Native goal state is opaque cursor metadata, independent of conversation turns. */
export function readClaudeGoal(value: unknown): ClaudeNativeGoal | null {
  if (!value || typeof value !== "object") return null;
  const goal = value as Record<string, unknown>;
  if (
    typeof goal.objective !== "string" ||
    !goal.objective.trim() ||
    goal.objective.length > 16000 ||
    (goal.status !== "active" && goal.status !== "complete") ||
    typeof goal.checks !== "number" ||
    !Number.isSafeInteger(goal.checks) ||
    goal.checks < 0
  )
    return null;
  return {
    objective: goal.objective,
    status: goal.status,
    checks: goal.checks,
    ...(typeof goal.lastCheck === "string" ? { lastCheck: goal.lastCheck.slice(0, 16000) } : {}),
  };
}

/** Only root synthetic SDK output can change the goal; model and child text cannot. */
export function nextClaudeGoal(
  current: ClaudeNativeGoal | null,
  message: SDKMessage,
): ClaudeNativeGoal | null | undefined {
  if (message.type === "assistant") {
    if (message.parent_tool_use_id !== null || message.message.model !== "<synthetic>")
      return undefined;
    const text = message.message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .trim();
    if (text.startsWith("Goal set: ")) {
      const objective = text.slice("Goal set: ".length).trim();
      return objective && objective.length <= 16000
        ? { objective, status: "active", checks: 0 }
        : undefined;
    }
    if (text.startsWith("Goal cleared: ") || text.startsWith("No goal set")) return null;
    const active = /^Goal active: ([\s\S]+?) \((?:not yet evaluated|(\d+) turns?)\)/u.exec(text);
    if (!active?.[1] || active[1].length > 16000) return undefined;
    const checks = Number(active[2] ?? 0);
    if (!Number.isSafeInteger(checks)) return undefined;
    return {
      ...(current?.objective === active[1] ? current : {}),
      objective: active[1],
      status: "active",
      checks,
    };
  }
  if (
    message.type !== "user" ||
    message.parent_tool_use_id !== null ||
    message.isSynthetic !== true ||
    current === null
  )
    return undefined;
  const prefix = `Stop hook feedback:\n[${current.objective}]: `;
  const content = message.message.content;
  const text =
    typeof content === "string"
      ? content
      : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  if (!text.startsWith(prefix)) return undefined;
  return {
    ...current,
    status: "active",
    checks: current.checks + 1,
    lastCheck: text.slice(prefix.length).trim().slice(0, 16000),
  };
}
