import type { OrchestrationEvent } from "@t3tools/contracts";
import type { MobileBatch, MobileMessagePatch } from "@t3tools/contracts/mobile/v1";
import type { MobilePeer } from "./listener.ts";
import { mobileEventAffectsShell } from "./mobileApi.ts";

const MAX_BATCH_BYTES = 256 * 1024;
const MAX_REPLAY_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15_000;

type Batch = typeof MobileBatch.Type;
type Patch = typeof MobileMessagePatch.Type;

function emptyBatch(sequence: number, selectedThreadId: string | null): Batch {
  return {
    afterSequence: sequence,
    throughSequence: sequence,
    selectedThreadId,
    threadIds: [],
    projectsChanged: false,
    tailInvalidated: false,
    transcriptReset: false,
    messages: [],
  };
}

function encodedBytes(batch: Batch) {
  return Buffer.byteLength(JSON.stringify({ channel: "mobile.batch", body: batch }));
}

export function makeMobileBatches(
  afterSequence: number,
  selectedThreadId: string | null,
  events: readonly OrchestrationEvent[],
): Batch[] {
  const batches: Batch[] = [];
  let batch = emptyBatch(afterSequence, selectedThreadId);
  let ids = new Set<string>();
  let messages: Patch[] = [];
  let bytes = encodedBytes(batch) + 32;
  function flush() {
    if (batch.throughSequence > batch.afterSequence) {
      batches.push({ ...batch, threadIds: [...ids], messages });
    }
    batch = emptyBatch(batch.throughSequence, selectedThreadId);
    bytes = encodedBytes(batch) + 32;
    ids = new Set();
    messages = [];
  }
  for (const event of events) {
    if (event.sequence <= batch.throughSequence) continue;
    const project = event.aggregateKind === "project";
    const affectsShell = mobileEventAffectsShell(event);
    const selected = !project && selectedThreadId === event.aggregateId;
    let patch: Patch | null = null;
    let invalidated =
      selected &&
      (event.type === "thread.reverted" ||
        event.type === "thread.proposed-plan-upserted" ||
        event.type === "thread.user-input-resolved" ||
        event.type === "thread.turn-processing-quiesced" ||
        (event.type === "thread.activity-appended" &&
          (affectsShell ||
            ["tool.started", "tool.completed", "runtime.error"].includes(
              event.payload.activity.kind,
            ))) ||
        (event.type === "thread.session-set" && event.payload.session.activeTurnId === null));
    let patchBytes = 0;
    if (selected && event.type === "thread.message-sent") {
      const payload = event.payload;
      invalidated = false;
      if (payload.text || !payload.streaming || payload.replace) {
        patch = {
          sequence: event.sequence,
          messageId: payload.messageId,
          role: payload.role,
          text: payload.text,
          createdAt: payload.createdAt,
          streaming: payload.streaming,
          completed: !payload.streaming,
          mode: !payload.replace && (payload.streaming || !payload.text) ? "append" : "replace",
        };
        patchBytes = Buffer.byteLength(JSON.stringify(patch)) + 1;
        if (patchBytes > MAX_BATCH_BYTES - 4096) {
          patch = null;
          patchBytes = 0;
          invalidated = true;
        }
      }
    }
    const shellId = !project && affectsShell ? event.aggregateId : null;
    const shellBytes = shellId ? Buffer.byteLength(JSON.stringify(shellId)) + 1 : 0;
    if (bytes + patchBytes + (shellId && !ids.has(shellId) ? shellBytes : 0) > MAX_BATCH_BYTES) {
      flush();
    }
    if (shellId && !ids.has(shellId)) {
      ids.add(shellId);
      bytes += shellBytes;
    }
    if (patch) {
      messages.push(patch);
      bytes += patchBytes;
    }
    batch = {
      ...batch,
      throughSequence: event.sequence,
      projectsChanged: batch.projectsChanged || (project && affectsShell),
      tailInvalidated: batch.tailInvalidated || invalidated,
      transcriptReset: batch.transcriptReset || (selected && event.type === "thread.reverted"),
    };
  }
  flush();
  return batches;
}

interface Subscription {
  selected: string | null;
  sequence: number;
  events: OrchestrationEvent[];
  ready: boolean;
  overflow: boolean;
  lastSent: number;
}

export function makeMobileLiveBatches(options: {
  backendIncarnation: string;
  head: () => Promise<number>;
  replay: (after: number, through: number) => Promise<readonly OrchestrationEvent[] | null>;
}) {
  const subscriptions = new Map<MobilePeer, Subscription>();
  const tracked = new WeakSet<MobilePeer>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function flush(peer: MobilePeer, subscription: Subscription) {
    if (!subscription.ready) return;
    const events = subscription.events;
    subscription.events = [];
    const batches = makeMobileBatches(subscription.sequence, subscription.selected, events);
    if (subscription.overflow) {
      // Force a new baseline rather than claiming a sequence range with missing data.
      subscriptions.delete(peer);
      peer.send("mobile.resync", {});
      return;
    }
    if (!batches.length && Date.now() - subscription.lastSent >= HEARTBEAT_MS)
      batches.push(emptyBatch(subscription.sequence, subscription.selected));
    for (const batch of batches) {
      peer.send("mobile.batch", batch);
      subscription.sequence = batch.throughSequence;
      subscription.lastSent = Date.now();
    }
  }

  return {
    event(event: OrchestrationEvent) {
      for (const [peer, subscription] of subscriptions) {
        if (event.sequence <= subscription.sequence || subscription.overflow) continue;
        if (subscription.events.length >= 512) {
          if (subscription.ready) flush(peer, subscription);
          else {
            subscription.events = [];
            subscription.overflow = true;
            continue;
          }
        }
        subscription.events.push(event);
      }
    },
    async subscribe(
      peer: MobilePeer,
      selected: string | null,
      resume?: {
        afterSequence: number;
        backendIncarnation: string;
      },
    ) {
      const subscription: Subscription = {
        selected,
        sequence: 0,
        events: [],
        ready: false,
        overflow: false,
        lastSent: Date.now(),
      };
      subscriptions.set(peer, subscription);
      if (!tracked.has(peer)) {
        tracked.add(peer);
        peer.onClose(() => {
          subscriptions.delete(peer);
          if (!subscriptions.size && timer) {
            clearInterval(timer);
            timer = undefined;
          }
        });
      }
      timer ??= setInterval(() => {
        for (const [client, active] of subscriptions) flush(client, active);
      }, 100);
      try {
        const head = await options.head();
        let batches: Batch[] | null = null;
        if (
          resume &&
          resume.backendIncarnation === options.backendIncarnation &&
          resume.afterSequence <= head &&
          head - resume.afterSequence <= 128
        ) {
          const events = await options.replay(resume.afterSequence, head);
          if (events) {
            const replay = makeMobileBatches(resume.afterSequence, selected, events);
            if (replay.reduce((bytes, batch) => bytes + encodedBytes(batch), 0) <= MAX_REPLAY_BYTES)
              batches = replay;
          }
        }
        subscription.sequence = head;
        subscription.events = subscription.events.filter(({ sequence }) => sequence > head);
        subscription.ready = true;
        return { head, snapshotRequired: batches === null, batches: batches ?? [] };
      } catch (error) {
        if (subscriptions.get(peer) === subscription) subscriptions.delete(peer);
        throw error;
      }
    },
  };
}
