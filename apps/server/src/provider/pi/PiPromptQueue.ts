import type { PiRpcRecord } from "./PiProtocol.ts";

/** Session-owned delivery queue. Only explicit compaction rejections are safe to retry. */
export class PiPromptQueue {
  compacting = false;
  #held: PiRpcRecord[] = [];
  #pending = new Map<unknown, PiRpcRecord>();
  #rejected = 0;

  submit(record: PiRpcRecord): PiRpcRecord[] {
    if (record.type !== "prompt") return [record];
    if (this.compacting) {
      this.#held.push(record);
      return [];
    }
    this.#pending.set(record.id, record);
    return [record];
  }

  observe(event: PiRpcRecord, hasActiveTurn = true): { consumed: boolean; send: PiRpcRecord[] } {
    if (event.type === "compaction_start") this.compacting = true;
    if (event.type === "response" && event.command === "prompt") {
      const prompt = this.#pending.get(event.id);
      this.#pending.delete(event.id);
      if (
        prompt &&
        this.compacting &&
        event.success === false &&
        typeof event.error === "string" &&
        event.error.startsWith("Cannot submit a prompt while compaction is in progress")
      ) {
        this.#held.splice(this.#rejected++, 0, prompt);
        return { consumed: true, send: [] };
      }
    }
    if (event.type !== "compaction_end") return { consumed: false, send: [] };
    this.compacting = false;
    this.#rejected = 0;
    const held = this.#held.splice(0);
    const send = hasActiveTurn ? held : [];
    for (const prompt of send) this.#pending.set(prompt.id, prompt);
    return { consumed: false, send };
  }

  clear(): void {
    this.#held = [];
    this.#pending.clear();
    this.#rejected = 0;
  }
}
