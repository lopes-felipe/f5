/** Child fixture for the server chaos suite: the production router and real store. */
import { createInterface } from "node:readline";
import type { OrchestrationEvent, OrchestrationReadModel } from "@t3tools/contracts";
import { createOrchestrationEventRouter } from "../orchestration/eventRouter";
import { useStore } from "../store";

const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let socket: WebSocket;
let url = process.argv[2]!;
let generation = 0;
let nextRpc = 0;
let incarnation: string | undefined;
const pending = new Map<
  number,
  {
    resolve: (snapshot: OrchestrationReadModel) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const router = createOrchestrationEventRouter({
  api: {
    readSnapshot: () =>
      new Promise((resolve, reject) => {
        const id = ++nextRpc;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Chaos snapshot RPC timed out"));
        }, 10_000);
        pending.set(id, {
          timer,
          reject,
          resolve: (snapshot) =>
            resolve({
              sequence: snapshot.snapshotSequence,
              provisional: false,
              merge: () => useStore.getState().syncServerReadModel(snapshot),
              finish: async () => {},
            }),
        });
        socket.send(JSON.stringify({ id, method: "snapshot" }));
      }),
  },
  scheduler: {
    raf: (callback) => Number(setTimeout(callback, 0)),
    cancelRaf: (id) => clearTimeout(id),
    setTimeout: (callback, ms) => Number(setTimeout(callback, ms)),
    clearTimeout: (id) => clearTimeout(id),
    queueMicrotask,
  },
  now: performance.now.bind(performance),
  actions: {
    applyBatch: (events) => useStore.getState().applyDomainEventBatch(events),
    applyEvent: (event) => useStore.getState().applyDomainEvent(event),
    onGap: () => {},
    onResynchronizing: () => {},
    onSynchronized: () => {},
    onRecoveryError: (message) => report({ type: "failure", message }),
    repairThreads: () => {},
    logPoison: (_events, error) => report({ type: "failure", message: String(error) }),
  },
});
function connect() {
  const ownGeneration = ++generation;
  socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    if (ownGeneration !== generation) return;
    const message = JSON.parse(String(event.data));
    if (message.type === "welcome") {
      if (incarnation !== undefined && incarnation !== message.incarnation) {
        useStore.getState().resetBackendState(message.incarnation);
        router.resetStream();
      }
      incarnation = message.incarnation;
      void router.syncSnapshot().then(
        () => report({ type: "ready" }),
        (error) => report({ type: "failure", message: String(error) }),
      );
    } else if (typeof message.id === "number") {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        clearTimeout(request.timer);
        request.resolve(message.snapshot);
      }
    } else if (message.channel === "orchestration.domainEvent")
      router.receive(message.data as OrchestrationEvent);
  });
  socket.addEventListener("close", () => {
    if (ownGeneration !== generation) return;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Socket closed"));
    }
    pending.clear();
    report({ type: "closed" });
  });
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.method === "inspect") {
    router.flushPending();
    report({
      type: "state",
      lifecycle: useStore.getState().threads.map((thread) => ({
        id: thread.id,
        status: thread.session?.orchestrationStatus ?? null,
        activeTurnId: thread.session?.activeTurnId ?? null,
        turnState: thread.latestTurn?.state ?? null,
      })),
      threads: useStore.getState().threads.map((thread) => ({
        id: thread.id,
        messages: thread.messages.map((message) => ({ id: message.id, text: message.text })),
      })),
    });
  } else if (command.method === "disconnect") socket.close();
  else if (command.method === "reconnect") {
    if (typeof command.url === "string") url = command.url;
    connect();
  } else if (command.method === "quit") {
    router.dispose();
    socket.close();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Disposed"));
    }
    pending.clear();
    process.stdout.write(`${JSON.stringify({ type: "bye" })}\n`, () => process.exit(0));
  }
});
connect();
