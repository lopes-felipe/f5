import type { RpcLane } from "@t3tools/shared/rpcScheduling";
import { describe, expect, it } from "vitest";

import {
  BACKGROUND_STARVATION_LIMIT,
  RPC_QUEUE_CAPS,
  RpcRequestScheduler,
  utf8ByteLength,
  type RpcRequestClass,
  type ScheduledRpc,
} from "./wsRequestScheduler";

let nextId = 0;
function entry(
  requestClass: RpcRequestClass,
  lane: RpcLane = "ordinary",
  bytes = 1,
): ScheduledRpc & { readonly label: string } {
  const id = String(++nextId);
  return { id, lane, requestClass, bytes, label: `${requestClass}:${id}` };
}

const all = () => true;

describe("RpcRequestScheduler", () => {
  it("sends exactly eight ordinary requests until a slot is released", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    const entries = Array.from({ length: 12 }, () => entry("mutation"));
    for (const item of entries) expect(scheduler.enqueue(item).ok).toBe(true);
    expect(scheduler.takeDispatchable(all).map((item) => item.id)).toEqual(
      entries.slice(0, 8).map((item) => item.id),
    );
    expect(scheduler.takeDispatchable(all)).toEqual([]);
    expect(scheduler.release(entries[0]!.id)).toBe(true);
    expect(scheduler.release(entries[0]!.id)).toBe(false);
    expect(scheduler.takeDispatchable(all).map((item) => item.id)).toEqual([entries[8]!.id]);
  });

  it("stops reads at six in flight while a mutation still sends", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    const reads = Array.from({ length: 8 }, () => entry("interactive"));
    for (const item of reads) scheduler.enqueue(item);
    expect(scheduler.takeDispatchable(all)).toHaveLength(6);
    const mutation = entry("mutation");
    scheduler.enqueue(mutation);
    expect(scheduler.takeDispatchable(all)).toEqual([mutation]);
  });

  it("stops background reads at four while an interactive read still sends", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    for (let index = 0; index < 6; index++) scheduler.enqueue(entry("background"));
    expect(scheduler.takeDispatchable(all)).toHaveLength(4);
    const interactive = entry("interactive");
    scheduler.enqueue(interactive);
    expect(scheduler.takeDispatchable(all)).toEqual([interactive]);
  });

  it("dequeues mutations before reads and admits a starving background read", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    scheduler.enqueue(entry("background"));
    scheduler.enqueue(entry("interactive"));
    for (let index = 0; index < 12; index++) scheduler.enqueue(entry("mutation"));

    const order: string[] = [];
    for (let round = 0; round < 3; round++) {
      const sent = scheduler.takeDispatchable(all);
      order.push(...sent.map((item) => item.requestClass));
      for (const item of sent) scheduler.release(item.id);
    }
    // Eight mutations fill the lane first; after eight consecutive foreground
    // dispatches the waiting background read goes before everything else.
    expect(order.slice(0, BACKGROUND_STARVATION_LIMIT)).toEqual(
      Array(BACKGROUND_STARVATION_LIMIT).fill("mutation"),
    );
    expect(order[BACKGROUND_STARVATION_LIMIT]).toBe("background");
    expect(order.slice(BACKGROUND_STARVATION_LIMIT + 1)).toEqual([
      "mutation",
      "mutation",
      "mutation",
      "mutation",
      "interactive",
    ]);
  });

  it("keeps control lanes available while the ordinary lane and its queue are full", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    for (let index = 0; index < 8 + RPC_QUEUE_CAPS.ordinary.count; index++) {
      scheduler.enqueue(entry("mutation"));
      if (index < 8) scheduler.takeDispatchable(all);
    }
    expect(scheduler.enqueue(entry("mutation")).ok).toBe(false);
    const controls = [
      entry("mutation", "stop"),
      entry("mutation", "answer"),
      entry("interactive", "health"),
    ];
    for (const control of controls) expect(scheduler.enqueue(control).ok).toBe(true);
    expect(
      scheduler
        .takeDispatchable(all)
        .map((item) => item.lane)
        .sort(),
    ).toEqual(["answer", "health", "stop"].sort());
  });

  it("applies per-lane count and byte caps only to that lane", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    for (let index = 0; index < RPC_QUEUE_CAPS.health.count; index++)
      expect(scheduler.enqueue(entry("interactive", "health")).ok).toBe(true);
    expect(scheduler.enqueue(entry("interactive", "health"))).toEqual({
      ok: false,
      lane: "health",
    });
    expect(scheduler.enqueue(entry("mutation", "stop", 900 * 1024)).ok).toBe(true);
    expect(scheduler.enqueue(entry("mutation", "stop", 200 * 1024))).toEqual({
      ok: false,
      lane: "stop",
    });
    expect(scheduler.enqueue(entry("mutation")).ok).toBe(true);
  });

  it("evicts the oldest queued background read for foreground work, never a mutation", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    const background = entry("background");
    scheduler.enqueue(background);
    for (let index = 1; index < RPC_QUEUE_CAPS.ordinary.count; index++)
      scheduler.enqueue(entry("mutation"));
    // A background read cannot displace anything.
    expect(scheduler.enqueue(entry("background")).ok).toBe(false);
    const interactive = entry("interactive");
    expect(scheduler.enqueue(interactive)).toEqual({ ok: true, evicted: background });
    expect(scheduler.isQueued(background.id)).toBe(false);
    // Only mutations and the interactive read remain: nothing else to evict.
    expect(scheduler.enqueue(entry("mutation")).ok).toBe(false);
  });

  it("caps the queued background subset at 192", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    for (let index = 0; index < 192; index++)
      expect(scheduler.enqueue(entry("background")).ok).toBe(true);
    expect(scheduler.enqueue(entry("background")).ok).toBe(false);
    expect(scheduler.enqueue(entry("interactive")).ok).toBe(true);
  });

  it("lets reads pass an ineligible read in place and removes aborted ones", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    const held = entry("interactive");
    const ready = entry("interactive");
    scheduler.enqueue(held);
    scheduler.enqueue(ready);
    expect(scheduler.takeDispatchable((item) => item.id !== held.id)).toEqual([ready]);
    expect(scheduler.isQueued(held.id)).toBe(true);
    expect(scheduler.remove(held.id)).toBe(held);
    expect(scheduler.queuedCount).toBe(0);
  });

  it("keeps mutations in send order behind an ineligible mutation, in every lane", () => {
    for (const lane of ["ordinary", "long"] as const) {
      const scheduler = new RpcRequestScheduler<ScheduledRpc>();
      const held = entry("mutation", lane);
      const later = entry("mutation", lane);
      const read = entry("interactive", lane);
      for (const item of [held, later, read]) scheduler.enqueue(item);
      // A read may still pass the held mutation; the later mutation may not.
      expect(scheduler.takeDispatchable((item) => item.id !== held.id)).toEqual([read]);
      expect(scheduler.takeDispatchable(all)).toEqual([held, later]);
    }
  });

  it("lets a later mutation pass a held one that does not hold it back", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    const held = entry("mutation");
    const related = entry("mutation");
    const unrelated = entry("mutation");
    for (const item of [held, related, unrelated]) scheduler.enqueue(item);
    expect(
      scheduler.takeDispatchable(
        (item) => item.id !== held.id,
        (_held, later) => later.id === related.id,
      ),
    ).toEqual([unrelated]);
    expect(scheduler.takeDispatchable(all)).toEqual([held, related]);
  });

  it("resets queues and slots for a new socket generation", () => {
    const scheduler = new RpcRequestScheduler<ScheduledRpc>();
    for (let index = 0; index < 10; index++) scheduler.enqueue(entry("mutation"));
    scheduler.takeDispatchable(all);
    scheduler.reset();
    expect(scheduler.inFlightCount).toBe(0);
    expect(scheduler.queuedCount).toBe(0);
    for (let index = 0; index < 8; index++) scheduler.enqueue(entry("mutation"));
    expect(scheduler.takeDispatchable(all)).toHaveLength(8);
  });
});

it("measures UTF-8 bytes without encoding", () => {
  for (const text of ["", "ascii", "é", "€", "😀", "a😀b", "\ud800"])
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
});
