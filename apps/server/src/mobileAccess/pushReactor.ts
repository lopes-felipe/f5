import { createHash } from "node:crypto";
import type { OrchestrationEvent } from "@t3tools/contracts";
import {
  MobileNotificationPrefs,
  type MobileShell,
  type MobileThreadShell,
} from "@t3tools/contracts/mobile/v1";
import { Effect, Schema } from "effect";
import type { makeApnsClient } from "./apnsClient.ts";
import type { makeMobileDeviceStore, MobileDevice } from "./deviceStore.ts";
import type { MobilePeer } from "./listener.ts";
import { mobileEventAffectsShell } from "./mobileApi.ts";

type Shell = typeof MobileThreadShell.Type;
type Kind = Exclude<keyof MobileNotificationPrefs, "previews">;
type Push = { threadId: string; kind: Kind; identity: string };
type Store = Effect.Success<typeof makeMobileDeviceStore>;
type Client = ReturnType<typeof makeApnsClient>;
const RETRY_MS = [1000, 5000, 30_000];

export const defaultNotificationPrefs: MobileNotificationPrefs = {
  approval: true,
  input: true,
  failed: true,
  "plan-ready": true,
  completed: false,
  previews: false,
};
const titleByKind: Record<Kind, string> = {
  approval: "Approval needed",
  input: "Answer needed",
  failed: "Turn failed",
  "plan-ready": "Plan ready",
  completed: "Turn completed",
};

function prefs(device: MobileDevice): MobileNotificationPrefs {
  if (!device.notify_json) return defaultNotificationPrefs;
  try {
    return Schema.decodeUnknownSync(MobileNotificationPrefs)(JSON.parse(device.notify_json));
  } catch {
    return defaultNotificationPrefs;
  }
}

function visible(thread: Shell) {
  return (
    !thread.isSideChat &&
    !thread.archivedAt &&
    !thread.settledAt &&
    (!thread.snoozedUntil || Date.parse(thread.snoozedUntil) <= Date.now())
  );
}

function notifications(thread: Shell): Push[] {
  const { attention, id } = thread;
  const make = (kind: Kind, identity: string): Push => ({ threadId: id, kind, identity });
  return [
    ...attention.pendingApprovalRequestIds.map((request) => make("approval", request)),
    ...attention.pendingInputRequestIds.map((request) => make("input", request)),
    ...(!thread.workflowRole && attention.latestFailedTurnId
      ? [make("failed", attention.latestFailedTurnId)]
      : []),
    ...(!thread.workflowRole && attention.planReady && thread.latestTurn
      ? [make("plan-ready", thread.latestTurn.turnId)]
      : []),
    ...(!thread.workflowRole && attention.latestCompletedTurnId
      ? [make("completed", attention.latestCompletedTurnId)]
      : []),
  ];
}

export function acceptsPushBundle(base: string, bundle: string) {
  return base.length > 0 && (bundle === base || bundle === base + ".dev");
}

export function makeMobilePushReactor(options: {
  serverId: () => string;
  readShell: (ids?: readonly string[]) => Promise<typeof MobileShell.Type>;
  store: Pick<Store, "active" | "devices" | "clearPush">;
  client: () => { client: Client; baseBundleId: string } | null;
}) {
  const dirty = new Set<string>();
  const previous = new Map<string, Shell>();
  const projects = new Map<string, string>();
  const leases = new Map<MobilePeer, { threadId: string; expiresAt: number }>();
  const observedPeers = new WeakSet<MobilePeer>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let generation = 0;
  let enabled = false;
  let seeded = false;
  let projectsDirty = false;

  function schedule(delay: number) {
    if (timer || inFlight || !enabled) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  }

  async function deliver(
    device: MobileDevice,
    push: Push,
    thread: Shell,
    attempt = 0,
    originalToken = device.push_token,
    originalGeneration = generation,
  ): Promise<void> {
    if (
      !enabled ||
      generation !== originalGeneration ||
      !options.store.active(device) ||
      !originalToken ||
      device.push_token !== originalToken
    )
      return;
    if (attempt > 0) {
      const current = (await options.readShell([push.threadId])).threads[0];
      if (
        !current ||
        !visible(current) ||
        !notifications(current).some(
          (currentPush) => currentPush.kind === push.kind && currentPush.identity === push.identity,
        )
      )
        return;
      thread = current;
    }
    const now = Date.now();
    for (const [peer, lease] of leases) {
      if (lease.expiresAt <= now) leases.delete(peer);
      else if (peer.device === device && lease.threadId === push.threadId) return;
    }
    const config = options.client();
    const environment = device.push_environment;
    const preference = prefs(device);
    if (
      !config ||
      !enabled ||
      generation !== originalGeneration ||
      !options.store.active(device) ||
      device.push_token !== originalToken ||
      !preference[push.kind] ||
      !acceptsPushBundle(config.baseBundleId, device.bundle_id) ||
      (environment !== "sandbox" && environment !== "production")
    )
      return;
    const projectName = thread.projectId ? projects.get(thread.projectId) : undefined;
    const preview = [projectName, thread.title].filter(Boolean).join(" · ").slice(0, 120);
    const collapseId = createHash("sha256")
      .update(JSON.stringify(push))
      .digest("base64url")
      .slice(0, 32);
    const payload = JSON.stringify({
      aps: {
        alert: {
          title: "F5: " + titleByKind[push.kind],
          ...(preference.previews ? { body: preview } : {}),
        },
        sound: "default",
      },
      f5: {
        serverId: options.serverId(),
        threadId: push.threadId,
        kind: push.kind,
        ...(push.kind === "approval" || push.kind === "input" ? { requestId: push.identity } : {}),
      },
    });
    if (Buffer.byteLength(payload) > 3500) return;
    const response = await config.client
      .send({
        environment,
        token: originalToken,
        bundleId: device.bundle_id,
        collapseId,
        priority: push.kind === "approval" || push.kind === "input" ? 10 : 5,
        payload,
      })
      .catch(() => ({ status: 0, reason: undefined }));
    if (response.status === 410 || response.reason === "BadDeviceToken") {
      await Effect.runPromise(options.store.clearPush(device, originalToken));
      return;
    }
    const wait = RETRY_MS[attempt];
    if (
      wait === undefined ||
      (response.status !== 429 && response.status !== 0 && response.status < 500)
    )
      return;
    if (!enabled || generation !== originalGeneration || !options.store.active(device)) return;
    const id = device.device_id + ":" + collapseId;
    if (retries.has(id)) return;
    retries.set(
      id,
      setTimeout(() => {
        retries.delete(id);
        void deliver(device, push, thread, attempt + 1, originalToken, originalGeneration).catch(
          () => {},
        );
      }, wait),
    );
  }

  async function flush() {
    inFlight = true;
    const currentGeneration = generation;
    const ids = [...dirty];
    dirty.clear();
    const full = !seeded || projectsDirty;
    projectsDirty = false;
    let failed = false;
    try {
      const snapshot = await options.readShell(full ? undefined : ids);
      if (!enabled || currentGeneration !== generation) return;
      if (full) {
        projects.clear();
        for (const { id, name } of snapshot.projects) projects.set(id, name);
      }
      const returned = new Set<string>();
      for (const thread of snapshot.threads) {
        returned.add(thread.id);
        const was = previous.get(thread.id);
        previous.set(thread.id, thread);
        if (!seeded || !visible(thread) || was?.archivedAt) continue;
        const known = new Set(was ? notifications(was).map((push) => JSON.stringify(push)) : []);
        for (const push of notifications(thread)) {
          if (known.has(JSON.stringify(push))) continue;
          for (const device of options.store.devices())
            void deliver(device, push, thread).catch(() => {});
        }
      }
      for (const id of full ? previous.keys() : ids) if (!returned.has(id)) previous.delete(id);
      seeded = true;
    } catch {
      if (currentGeneration === generation) {
        for (const id of ids) dirty.add(id);
        projectsDirty ||= full;
        failed = true;
      }
    } finally {
      inFlight = false;
      if (!seeded || dirty.size || projectsDirty) schedule(failed ? 1000 : 250);
    }
  }

  return {
    enabled(next: boolean) {
      if (enabled === next) return;
      enabled = next;
      generation++;
      if (enabled) {
        schedule(0);
      } else {
        clearTimeout(timer);
        timer = undefined;
        for (const retry of retries.values()) clearTimeout(retry);
        retries.clear();
        previous.clear();
        projects.clear();
        leases.clear();
        dirty.clear();
        seeded = false;
        projectsDirty = false;
      }
    },
    event(event: OrchestrationEvent) {
      if (!enabled || !mobileEventAffectsShell(event)) return;
      if (event.aggregateKind === "project") projectsDirty = true;
      else dirty.add(event.aggregateId);
      schedule(250);
    },
    presence(peer: MobilePeer, foreground: boolean, viewingThreadId: string | null) {
      if (!foreground || !viewingThreadId) {
        leases.delete(peer);
        return;
      }
      if (!observedPeers.has(peer)) {
        observedPeers.add(peer);
        peer.onClose(() => leases.delete(peer));
      }
      leases.set(peer, { threadId: viewingThreadId, expiresAt: Date.now() + 15_000 });
    },
  };
}
