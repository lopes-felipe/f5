import { piRecordField, piRecordNumber, piRecordString, type PiRpcRecord } from "./PiProtocol.ts";
const integer = (value: unknown, key: string) => {
  const number = piRecordNumber(value, key);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
};
export function piContextUsage(
  value: unknown,
): { contextTokens: number; modelContextWindowTokens: number } | undefined {
  const usage = piRecordField(value, "contextUsage");
  const contextTokens = integer(usage, "tokens"),
    modelContextWindowTokens = integer(usage, "contextWindow");
  return contextTokens === undefined ||
    modelContextWindowTokens === undefined ||
    modelContextWindowTokens === 0
    ? undefined
    : { contextTokens, modelContextWindowTokens };
}
const fields = {
  input_tokens: "input",
  output_tokens: "output",
  cache_read_input_tokens: "cacheRead",
  cache_creation_input_tokens: "cacheWrite",
  total_tokens: "totalTokens",
} as const;
interface MessageUsage {
  usage: Record<string, number>;
  totalCostUsd?: number;
}
/** Each assistant message reports cumulative counters; updates replace rather than add. */
export class PiTurnUsage {
  #ordinal = 0;
  readonly #messages = new Map<number, MessageUsage>();
  clear() {
    this.#ordinal = 0;
    this.#messages.clear();
  }
  observe(event: PiRpcRecord): boolean {
    if (event.type === "message_start" && piRecordString(event.message, "role") === "assistant")
      this.#ordinal++;
    const value =
      event.type === "message_update"
        ? event.usage
        : event.type === "message_end" && piRecordString(event.message, "role") === "assistant"
          ? piRecordField(event.message, "usage")
          : undefined;
    if (value === undefined) return true;
    if (!this.#messages.has(this.#ordinal) && this.#messages.size >= 4096) return false;
    const usage: Record<string, number> = {};
    for (const [canonical, native] of Object.entries(fields)) {
      const count = integer(value, native);
      if (count !== undefined) usage[canonical] = count;
    }
    const cost = piRecordNumber(piRecordField(value, "cost"), "total");
    if (Object.keys(usage).length || (cost !== undefined && cost >= 0)) {
      this.#messages.set(this.#ordinal, {
        usage,
        ...(cost !== undefined && cost >= 0 ? { totalCostUsd: cost } : {}),
      });
    }
    return true;
  }
  snapshot(): { usage?: Record<string, number>; totalCostUsd?: number } {
    if (!this.#messages.size) return {};
    const messages = [...this.#messages.values()];
    const usage: Record<string, number> = {};
    for (const key of Object.keys(fields)) {
      const sum = messages.reduce((total, message) => total + (message.usage[key] ?? NaN), 0);
      if (Number.isSafeInteger(sum)) usage[key] = sum;
    }
    const totalCostUsd = messages.reduce(
      (total, message) => total + (message.totalCostUsd ?? NaN),
      0,
    );
    return {
      ...(Object.keys(usage).length ? { usage } : {}),
      ...(Number.isFinite(totalCostUsd) ? { totalCostUsd } : {}),
    };
  }
}
