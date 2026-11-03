import { EventId, RuntimeItemId, type ProviderEvent } from "@t3tools/contracts";
import { appendGeneratedImageEmbeds } from "@t3tools/shared/generatedImageMarkdown";

interface ImageTurn {
  running: Set<string>;
  saved: Map<string, string>;
  answer?: ProviderEvent;
  terminal?: ProviderEvent;
}

/** Retain the native terminal until all image items already started have completed. */
export class CodexGeneratedImages {
  #turns = new Map<string, ImageTurn>();

  project(event: ProviderEvent): ProviderEvent[] {
    const prefix = JSON.stringify([
      event.threadId,
      event.providerInstanceId,
      event.sessionGeneration,
    ]);
    const key = prefix + ":" + event.turnId;
    if (event.method === "session/closed" || event.method === "session/exited") {
      for (const id of this.#turns.keys()) if (id.startsWith(prefix + ":")) this.#turns.delete(id);
      return [event];
    }
    if (!event.turnId) return [event];
    const payload = event.payload as
      | { item?: Record<string, unknown>; turn?: { status?: string } }
      | undefined;
    const item = payload?.item;
    let state = this.#turns.get(key);
    if (
      item?.type === "imageGeneration" &&
      (event.method === "item/started" || event.method === "item/completed")
    ) {
      if (!state) {
        state = { running: new Set(), saved: new Map() };
        this.#turns.set(key, state);
      }
      const id = String(item.id);
      if (event.method === "item/started") state.running.add(id);
      else {
        state.running.delete(id);
        const path = item.savedPath ?? item.saved_path;
        if (
          item.status === "completed" &&
          item.failure == null &&
          typeof path === "string" &&
          path.trim()
        )
          state.saved.set(id, path);
      }
    }
    if (!state) return [event];
    if (
      event.method === "item/completed" &&
      item?.type === "agentMessage" &&
      item.phase !== "commentary"
    ) {
      const previous = state.answer;
      state.answer = event;
      return previous ? [previous] : [];
    }
    const output = [event];
    if (event.method === "turn/completed" || event.method === "turn/aborted") {
      state.terminal = event;
      output.length = 0;
      if (payload?.turn?.status !== "completed") state.running.clear();
    }
    if (!state.terminal || state.running.size) return output;
    const answer = state.answer;
    const original = (answer?.payload as { item?: Record<string, unknown> } | undefined)?.item;
    const text = typeof original?.text === "string" ? original.text : "";
    const finalText = appendGeneratedImageEmbeds(text, state.saved.values());
    if (answer || finalText) {
      const base = answer ?? state.terminal;
      output.push({
        ...base,
        id: EventId.makeUnsafe("generated-images:" + base.id),
        itemId: answer?.itemId ?? RuntimeItemId.make("generated-images:" + event.turnId),
        method: "item/completed",
        payload: {
          item: {
            ...original,
            type: "agentMessage",
            id: original?.id ?? "generated-images:" + event.turnId,
            text: finalText,
          },
        },
      });
    }
    output.push(state.terminal);
    this.#turns.delete(key);
    return output;
  }
}
