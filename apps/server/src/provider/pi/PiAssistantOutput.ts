import { piRecordField, piRecordNumber, piRecordString, type PiRpcRecord } from "./PiProtocol.ts";

export interface PiAssistantAction {
  readonly type: "start" | "delta" | "complete";
  readonly itemId: string;
  readonly reasoning: boolean;
  readonly text: string;
}
interface Block {
  readonly itemId: string;
  readonly reasoning: boolean;
  text: string;
}

/** Only the current message is buffered. Final native text must extend its emitted prefix. */
export class PiAssistantOutput {
  #ordinal = 0;
  #ended = false;
  #bytes = 0;
  readonly #blocks = new Map<string, Block>();
  clear() {
    this.#blocks.clear();
    this.#bytes = 0;
    this.#ended = false;
    this.#ordinal = 0;
  }
  completeOpen(): readonly PiAssistantAction[] {
    const actions = [...this.#blocks.values()].map((block) => ({
      type: "complete" as const,
      ...block,
    }));
    this.#blocks.clear();
    this.#bytes = 0;
    this.#ended = true;
    return actions;
  }
  observe(event: PiRpcRecord): readonly PiAssistantAction[] | null {
    if (event.type === "message_start" && piRecordString(event.message, "role") === "assistant") {
      // Starting another message without completing the previous one loses authoritative text.
      if (this.#blocks.size) return null;
      this.#ordinal++;
      this.#ended = false;
      return [];
    }
    const output: PiAssistantAction[] = [];
    const append = (index: number, reasoning: boolean, text: string, authoritative: boolean) => {
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= 256 ||
        text.length > 2 * 1024 * 1024
      )
        return false;
      const key = `${index}:${reasoning}`;
      const existing = this.#blocks.get(key);
      if (authoritative && existing && !text.startsWith(existing.text)) return false;
      const delta = authoritative ? text.slice(existing?.text.length ?? 0) : text;
      const size = Buffer.byteLength(delta);
      if (this.#bytes + size > 2 * 1024 * 1024 || (!existing && this.#blocks.size >= 256))
        return false;
      this.#bytes += size;
      const block = existing ?? {
        itemId: `${this.#ordinal}:${index}:${reasoning ? "thinking" : "text"}`,
        reasoning,
        text: "",
      };
      if (!existing) {
        this.#blocks.set(key, block);
        output.push({ type: "start", ...block });
      }
      block.text += delta;
      if (delta) output.push({ type: "delta", itemId: block.itemId, reasoning, text: delta });
      return true;
    };
    if (event.type === "message_update") {
      if (this.#ended) return null;
      const delta = event.assistantMessageEvent;
      const kind = piRecordString(delta, "type");
      if (kind !== "text_delta" && kind !== "thinking_delta") return [];
      const text = piRecordString(delta, "delta");
      const index = piRecordNumber(delta, "contentIndex") ?? 0;
      if (text === undefined || !append(index, kind === "thinking_delta", text, false)) return null;
    }
    if (event.type === "message_end" && piRecordString(event.message, "role") === "assistant") {
      if (this.#ended) return [];
      const content = piRecordField(event.message, "content");
      if (!Array.isArray(content) || content.length > 256) return null;
      const seen = new Set<string>();
      for (const [index, part] of content.entries()) {
        const kind = piRecordString(part, "type");
        if (kind !== "text" && kind !== "thinking") continue;
        const reasoning = kind === "thinking";
        seen.add(`${index}:${reasoning}`);
        const text = piRecordString(part, reasoning ? "thinking" : "text");
        if (text === undefined || !append(index, reasoning, text, true)) return null;
      }
      for (const [key, block] of this.#blocks) {
        if (!seen.has(key)) return null;
        output.push({ type: "complete", ...block });
      }
      this.#blocks.clear();
      this.#bytes = 0;
      this.#ended = true;
    }
    return output;
  }
}
