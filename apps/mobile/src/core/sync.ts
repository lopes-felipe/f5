import {
  MobileBatch,
  MobileHistory,
  MobileShell,
  MobileSubscribeResult,
  type MobileThreadTail,
  type mobileMethods,
} from "@t3tools/contracts/mobile/v1";
import { Schema } from "effect";
import { decodeMobileBootstrap as decodeBootstrap, decodeMobileTail as decodeTail } from "./decode";
import {
  applyMessageBatch,
  MAX_MESSAGES,
  initialModel,
  mergeHistory,
  replaceShellEntries,
  updateDetail,
  useMobileModel,
  type Detail,
} from "./model";
import type { PairedServer } from "./pairing";
import { readPairedServer, writePairedServer } from "./storage";
import {
  connectMobile,
  MobileConnectionError,
  MobileRpcError,
  readMobileShell,
  type MobileSocket,
} from "./wsClient";

type Batch = typeof MobileBatch.Type;
type Call = keyof typeof mobileMethods;
type Body<M extends Call> = (typeof mobileMethods)[M]["Type"];
type Link = {
  controller: AbortController;
  socket?: MobileSocket;
  sequence: number;
  selection: number;
  paused: boolean;
  selectionId: string | null;
  batches: Batch[];
  refresh: ReturnType<typeof setTimeout> | undefined;
  synchronizing: boolean;
  renew: boolean;
  historyRevision: number;
  openedAt?: number;
};
type ResumePoint = { sequence: number; incarnation: string; selected: string | null };
const decodeBatch = Schema.decodeUnknownSync(MobileBatch);
const decodeShell = Schema.decodeUnknownSync(MobileShell);
const decodeSubscribe = Schema.decodeUnknownSync(MobileSubscribeResult);
const decodeHistory = Schema.decodeUnknownSync(MobileHistory);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const get = useMobileModel.getState;
const set = useMobileModel.setState;

let current: Link | undefined;
let resume: ResumePoint | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryAt = 0;
let failures = 0;
let fastSlowRetry = true;
let identityGeneration = 0;
let loaded: Promise<void> | undefined;

const owns = (link: Link, selection = link.selection) =>
  current === link && !link.controller.signal.aborted && link.selection === selection;

function stop(keepResume = true) {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  const old = current;
  current = undefined;
  if (!keepResume) resume = undefined;
  if (!old) return;
  clearTimeout(old.refresh);
  old.controller.abort();
}

async function revoke() {
  identityGeneration++;
  stop(false);
  set({ ...initialModel, loaded: true, active: get().active, status: "revoked" });
  await writePairedServer(null).catch(() => {});
}

function scheduleRetry(wait: number) {
  clearTimeout(retryTimer);
  if (!get().active || !get().server) return;
  retryTimer = setTimeout(
    () => {
      retryTimer = undefined;
      void start();
    },
    Math.max(wait, retryAt - Date.now()),
  );
}

function disconnected(link: Link, error: unknown, slow = false) {
  if (!owns(link)) return;
  const reason =
    error instanceof MobileConnectionError ? error : new MobileConnectionError("offline");
  stop();
  set({ stale: true, status: reason.state });
  if (reason.state === "revoked") {
    void revoke();
    return;
  }
  if (reason.state === "update-required" || reason.state === "identity-changed") return;
  retryAt = Math.max(retryAt, reason.retryAt);
  if (link.openedAt !== undefined && Date.now() - link.openedAt >= 35_000) {
    failures = 0;
    fastSlowRetry = true;
  }
  const immediate = slow && fastSlowRetry;
  if (slow) fastSlowRetry = false;
  const backoff = Math.min(30_000, 750 * 2 ** Math.min(failures++, 6));
  scheduleRetry(immediate ? 0 : backoff * (0.75 + Math.random() / 2));
}

async function start() {
  const { active, server } = get();
  if (!active || !server || current) return;
  if (retryAt > Date.now()) {
    set({ status: "rate-limited", stale: true });
    scheduleRetry(0);
    return;
  }
  const link: Link = {
    controller: new AbortController(),
    sequence: 0,
    selection: 0,
    paused: false,
    selectionId: null,
    batches: [],
    refresh: undefined,
    synchronizing: false,
    renew: false,
    historyRevision: 0,
  };
  current = link;
  set({ status: "connecting", stale: true, syncTimedOut: false });
  try {
    const socket = await connectMobile(server, link.controller.signal, {
      push: (channel, body) => receive(link, channel, body),
      disconnected: (error, slow) => disconnected(link, error, slow),
    });
    if (!owns(link)) return;
    link.socket = socket;
    link.openedAt = Date.now();
    set({ info: socket.welcome, status: "syncing" });
    await hydrate(link, true);
  } catch (error) {
    disconnected(link, error);
  }
}

function receive(link: Link, channel: string, body: unknown) {
  if (!owns(link) || link.paused) return;
  if (channel !== "mobile.batch") {
    invalidate(link);
    return;
  }
  try {
    const batch = decodeBatch(body);
    if (batch.selectedThreadId !== link.selectionId) return;
    // Invalidate in-flight pagination immediately, including during a tail read.
    if (batch.transcriptReset && batch.throughSequence > link.sequence) link.historyRevision++;
    if (link.batches.length >= 128) {
      invalidate(link);
      return;
    }
    link.batches.push(batch);
    if (!link.synchronizing) void processBatches(link);
  } catch {
    invalidate(link);
  }
}

function invalidate(link: Link) {
  resume = undefined;
  link.batches = [];
  link.renew = true;
  set({ stale: true });
  if (link.refresh) return;
  link.refresh = setTimeout(() => {
    link.refresh = undefined;
    if (owns(link) && !link.synchronizing && !link.paused) void hydrate(link, false);
  }, 2000);
}

async function settling<T>(
  link: Link,
  selection: number,
  read: () => Promise<T>,
  valid: (value: T) => boolean,
) {
  const deadline = Date.now() + 10_000;
  let wait = 150;
  do {
    try {
      const value = await read();
      if (!owns(link, selection)) return undefined;
      if (valid(value)) return value;
    } catch (error) {
      if (!owns(link, selection)) return undefined;
      if (
        !(error instanceof MobileRpcError) ||
        (error.code !== "busy" && error.code !== "starting")
      )
        throw error;
      wait = Math.max(wait, error.retryAfterMs ?? 0);
    }
    if (Date.now() + wait > deadline) break;
    await delay(wait);
    wait = Math.min(wait * 2, 1000);
  } while (owns(link, selection));
  if (owns(link, selection)) set({ syncTimedOut: true, stale: true });
  return undefined;
}

function detailFromTail(tail: typeof MobileThreadTail.Type, previous?: Detail): Detail {
  const oldest = tail.messages[0];
  if (!oldest) return { ...tail, cursor: null };
  if (previous) {
    const older = previous.messages.filter(
      (message) =>
        message.createdAt < oldest.createdAt ||
        (message.createdAt === oldest.createdAt && message.messageId < oldest.messageId),
    );
    const messages = [...older, ...tail.messages].slice(-MAX_MESSAGES);
    return { ...tail, messages, cursor: messages.length >= MAX_MESSAGES ? null : previous.cursor };
  }
  return {
    ...tail,
    cursor:
      (tail.hasOlderMessages ?? tail.messages.length === 50)
        ? { createdAt: oldest.createdAt, messageId: oldest.messageId }
        : null,
  };
}

async function refreshShell(
  link: Link,
  selection: number,
  minimum: number,
  ids?: readonly string[],
) {
  const server = get().server;
  const socket = link.socket;
  if (!server || !socket) return false;
  const incarnation = socket.welcome.backendIncarnation;
  for (const subset of ids
    ? Array.from({ length: Math.ceil(ids.length / 256) }, (_, index) =>
        ids.slice(index * 256, index * 256 + 256),
      )
    : [undefined]) {
    const fresh = await settling(
      link,
      selection,
      async () =>
        decodeShell(
          subset
            ? await socket.rpc("getThreadShells", { threadIds: subset })
            : await readMobileShell(socket.origin, server, incarnation, link.controller.signal),
        ),
      (snapshot) =>
        snapshot.snapshotSequence >= minimum && snapshot.backendIncarnation === incarnation,
    );
    if (!fresh) return false;
    const existing = get().shell;
    set({ shell: subset && existing ? replaceShellEntries(existing, fresh, subset) : fresh });
  }
  return true;
}

async function refreshTail(
  link: Link,
  selection: number,
  threadId: string,
  minimum: number,
  preserve: boolean,
) {
  const socket = link.socket;
  if (!socket) return false;
  const revision = link.historyRevision;
  const tail = await settling(
    link,
    selection,
    async () => decodeTail(await socket.rpc("getThreadTail", { threadId, messageLimit: 50 })),
    (value) => value.snapshotSequence >= minimum,
  );
  if (!tail) return false;
  const keepHistory =
    preserve &&
    revision === link.historyRevision &&
    !link.batches.some((batch) => batch.transcriptReset);
  updateDetail(
    threadId,
    detailFromTail(tail, keepHistory ? get().details.get(threadId) : undefined),
  );
  return true;
}

async function hydrate(link: Link, allowResume: boolean) {
  const socket = link.socket;
  if (!socket || !owns(link) || link.paused) return;
  const selected = get().selected;
  const selection = ++link.selection;
  link.selectionId = selected;
  link.historyRevision++;
  link.batches = [];
  link.renew = false;
  link.synchronizing = true;
  set({ stale: true, status: "syncing", syncTimedOut: false });
  try {
    const incarnation = socket.welcome.backendIncarnation;
    const point = allowResume && resume?.incarnation === incarnation ? resume : null;
    resume = undefined;
    const reply = await settling(
      link,
      selection,
      async () =>
        decodeSubscribe(
          await socket.rpc("subscribe", {
            selectedThreadId: selected,
            ...(point
              ? { resume: { afterSequence: point.sequence, backendIncarnation: incarnation } }
              : {}),
          }),
        ),
      () => true,
    );
    if (!reply) return;
    if (
      !reply.snapshotRequired &&
      point &&
      get().shell &&
      (!selected || point.selected !== selected || get().details.has(selected))
    ) {
      link.sequence = point.sequence;
      link.batches.unshift(...reply.batches);
      if (
        selected &&
        point.selected !== selected &&
        !(await refreshTail(link, selection, selected, reply.head, false))
      )
        return;
    } else {
      link.sequence = reply.head;
      const [shell, detail] = await Promise.all([
        refreshShell(link, selection, reply.head),
        selected ? refreshTail(link, selection, selected, reply.head, false) : true,
      ]);
      if (!shell || !detail) return;
    }
    if (!owns(link, selection)) return;
  } catch (error) {
    if (owns(link, selection)) disconnected(link, error);
    return;
  } finally {
    if (owns(link, selection)) link.synchronizing = false;
  }
  if (link.renew) invalidate(link);
  else await processBatches(link);
}

async function processBatches(link: Link) {
  if (!owns(link) || link.synchronizing || link.paused || !link.socket || link.renew) return;
  if (get().syncTimedOut) return;
  const selection = link.selection;
  link.synchronizing = true;
  try {
    while (link.batches.length && owns(link, selection) && !link.renew) {
      const batches = link.batches.splice(0);
      const threadIds = new Set<string>();
      let projectChanged = false;
      let tailRequired = false;
      let flushHistory = false;
      for (const batch of batches) {
        if (batch.throughSequence <= link.sequence) continue;
        if (batch.afterSequence !== link.sequence) {
          invalidate(link);
          return;
        }
        for (const id of batch.threadIds) threadIds.add(id);
        projectChanged ||= batch.projectsChanged;
        const id = link.selectionId;
        const detail = id ? get().details.get(id) : undefined;
        if (id && detail) {
          const applied = applyMessageBatch(detail, batch);
          updateDetail(id, applied.detail);
          tailRequired ||= applied.needsTail;
        }
        // The message watermark can already cover the rewind while older cached
        // pages still belong to the previous transcript.
        flushHistory ||= batch.transcriptReset;
        tailRequired ||= batch.transcriptReset;
        link.sequence = batch.throughSequence;
      }
      if (flushHistory) link.historyRevision++;
      if (projectChanged || threadIds.size || tailRequired) {
        set({ stale: true });
        resume = undefined;
        const [shell, tail] = await Promise.all([
          projectChanged || threadIds.size
            ? refreshShell(
                link,
                selection,
                link.sequence,
                projectChanged ? undefined : [...threadIds],
              )
            : true,
          tailRequired && link.selectionId
            ? refreshTail(link, selection, link.selectionId, link.sequence, !flushHistory)
            : true,
        ]);
        if (!shell || !tail) return;
      }
    }
    if (!owns(link, selection) || link.renew || link.paused) return;
    resume = {
      sequence: link.sequence,
      incarnation: link.socket.welcome.backendIncarnation,
      selected: link.selectionId,
    };
    set({ status: "ready", stale: false, syncTimedOut: false });
  } catch (error) {
    if (owns(link, selection)) {
      if (error instanceof MobileRpcError && error.code === "stale-action") {
        set({ selected: null });
        invalidate(link);
      } else disconnected(link, error);
    }
  } finally {
    if (owns(link, selection)) link.synchronizing = false;
  }
}

export const mobileSync = {
  load() {
    loaded ??= (async () => {
      const identity = identityGeneration;
      const server = await readPairedServer().catch(() => null);
      if (identity !== identityGeneration) return;
      set({ server, loaded: true });
      void start();
    })();
    return loaded;
  },
  async setServer(server: PairedServer | null) {
    const generation = ++identityGeneration;
    stop(false);
    retryAt = 0;
    failures = 0;
    fastSlowRetry = true;
    await writePairedServer(server);
    if (identityGeneration !== generation) return;
    set({ ...initialModel, loaded: true, active: get().active, server });
    void start();
  },
  async forgetServer() {
    const server = get().server;
    const link = current;
    if (link?.socket && !link.paused) {
      link.paused = true;
      set({ status: "syncing", stale: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        link.socket.rpc("unregisterPush", {}).catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1500);
        }),
      ]);
      clearTimeout(timer);
    }
    if (get().server === server) await mobileSync.setServer(null);
  },
  active(active: boolean) {
    if (get().active === active) return;
    set({ active, stale: true });
    if (active) {
      stop();
      void start();
      return;
    }
    clearTimeout(retryTimer);
    retryTimer = undefined;
    const link = current;
    if (!link) return;
    link.paused = true;
    clearTimeout(link.refresh);
    if (link.socket) {
      void link.socket
        .rpc("setPresence", { foreground: false, viewingThreadId: null })
        .catch(() => {});
      void link.socket.drain().finally(() => {
        if (current === link) stop();
      });
    } else stop();
  },
  select(threadId: string | null) {
    if (get().selected === threadId) return;
    set({ selected: threadId, stale: true });
    if (current) void hydrate(current, true);
  },
  networkChanged() {
    if (!get().active || !get().server || get().status === "revoked") return;
    stop();
    void start();
  },
  retry() {
    if (!get().active) return;
    if (current?.socket && get().status === "ready") void hydrate(current, false);
    else {
      stop();
      void start();
    }
  },
  async rpc<M extends Call>(method: M, body: Body<M>, action = false): Promise<unknown> {
    const link = current;
    const state = get();
    if (!link?.socket || link.paused || (action && (state.stale || state.status !== "ready")))
      throw new MobileRpcError("starting");
    const selection = link.selection;
    try {
      const result = await link.socket.rpc(method, body);
      if (!owns(link, selection)) throw new MobileRpcError("stale-action");
      return result;
    } catch (error) {
      if (
        action &&
        owns(link, selection) &&
        error instanceof MobileRpcError &&
        error.code === "stale-action"
      )
        invalidate(link);
      throw error;
    }
  },
  async presence() {
    const link = current;
    if (!link?.socket || !get().active || link.paused) return;
    await link.socket
      .rpc("setPresence", { foreground: true, viewingThreadId: get().selected })
      .catch(() => {});
  },
  async history(threadId: string) {
    const link = current;
    const cursor = get().details.get(threadId)?.cursor;
    if (!link?.socket || link.selectionId !== threadId || !cursor || get().stale) return;
    const selection = link.selection;
    const revision = link.historyRevision;
    const page = decodeHistory(
      await link.socket.rpc("getThreadHistory", { threadId, cursor, limit: 50 }),
    );
    if (!owns(link, selection) || revision !== link.historyRevision) return;
    const detail = get().details.get(threadId);
    if (detail?.cursor === cursor) updateDetail(threadId, mergeHistory(detail, page));
  },
  async probe() {
    return decodeBootstrap(await this.rpc("probe", {}));
  },
};
