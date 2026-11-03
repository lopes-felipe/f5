import {
  EventId,
  ProviderItemId,
  type ProviderEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { appendGeneratedImageEmbeds } from "@t3tools/shared/generatedImageMarkdown";

interface ImageTurn {
  event: ProviderEvent;
  saved: Map<string, string>;
  shown: Set<string>;
  answer: string;
  ended: boolean;
}

/** Native messages and terminals never wait for image work. Late images get their own reply. */
export class CodexGeneratedImages {
  #turns = new Map<string, ImageTurn>();
  #cancelledTargets = new Set<string>();
  #key(event: ProviderEvent): string {
    return JSON.stringify([
      event.threadId,
      event.providerInstanceId,
      event.sessionGeneration,
      event.turnId,
    ]);
  }

  #flush(state: ImageTurn, createdAt: string): ProviderEvent[] {
    const paths = [...state.saved.values()].filter(
      (path) =>
        !state.shown.has(path) && appendGeneratedImageEmbeds(state.answer, [path]) !== state.answer,
    );
    for (const path of state.saved.values()) state.shown.add(path);
    if (!paths.length) return [];
    const base = state.event;
    const id = "generated-images:" + base.id + ":" + state.shown.size;
    return [
      {
        ...base,
        createdAt,
        id: EventId.makeUnsafe(id),
        itemId: ProviderItemId.make(id),
        method: "item/completed",
        payload: {
          item: { type: "agentMessage", id, text: appendGeneratedImageEmbeds("", paths) },
        },
      },
    ];
  }

  cancel(threadId: ThreadId, turnId?: TurnId): void {
    if (this.#cancelledTargets.size >= 64)
      this.#cancelledTargets.delete(this.#cancelledTargets.values().next().value!);
    this.#cancelledTargets.add(JSON.stringify([threadId, turnId ?? null]));
    for (const [key, state] of this.#turns) {
      if (state.event.threadId === threadId && (!turnId || state.event.turnId === turnId)) {
        this.#turns.delete(key);
      }
    }
  }

  project(event: ProviderEvent): ProviderEvent[] {
    // At most 64 turns of bookkeeping are retained, never a completion or user question.
    if (event.method === "session/closed" || event.method === "session/exited") {
      const output: ProviderEvent[] = [];
      for (const [key, state] of this.#turns) {
        if (
          state.event.threadId !== event.threadId ||
          state.event.sessionGeneration !== event.sessionGeneration ||
          state.event.providerInstanceId !== event.providerInstanceId
        )
          continue;
        output.push(...this.#flush(state, event.createdAt));
        this.#turns.delete(key);
      }
      return [...output, event];
    }
    if (!event.turnId) return [event];
    const key = this.#key(event);
    const target = JSON.stringify([event.threadId, event.turnId]);
    const threadTarget = JSON.stringify([event.threadId, null]);
    if (event.method === "turn/started") {
      this.#cancelledTargets.delete(threadTarget);
      this.#cancelledTargets.delete(target);
    }
    if (this.#cancelledTargets.has(target) || this.#cancelledTargets.has(threadTarget))
      return [event];
    const item = (event.payload as { item?: Record<string, unknown> } | undefined)?.item;
    let state = this.#turns.get(key);
    if (
      item?.type === "imageGeneration" &&
      (event.method === "item/started" || event.method === "item/completed")
    ) {
      if (!state) {
        if (this.#turns.size >= 64) this.#turns.delete(this.#turns.keys().next().value!);
        state = {
          event,
          saved: new Map(),
          shown: new Set(),
          answer: "",
          ended: false,
        };
        this.#turns.set(key, state);
      }
      const id = String(item.id);
      if (event.method === "item/completed") {
        const path = "f5ImagePath" in item ? item.f5ImagePath : (item.savedPath ?? item.saved_path);
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
      item.delivery !== "async" &&
      item.phase !== "commentary" &&
      typeof item.text === "string"
    )
      state.answer = item.text;
    const terminal = event.method === "turn/completed" || event.method === "turn/aborted";
    if (terminal) state.ended = true;
    const images = state.ended ? this.#flush(state, event.createdAt) : [];
    return terminal ? [...images, event] : [event, ...images];
  }
}
