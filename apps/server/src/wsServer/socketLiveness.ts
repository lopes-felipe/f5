import type { WebSocket } from "ws";

/** Ping control frames stay independent of application/RPC backpressure. */
export function makeSocketLiveness() {
  const sockets = new Map<
    WebSocket,
    { missed: number; awaiting: boolean; pong: () => void; close: () => void }
  >();
  const remove = (socket: WebSocket) => {
    const state = sockets.get(socket);
    if (!state) return;
    socket.off("pong", state.pong);
    socket.off("close", state.close);
    sockets.delete(socket);
  };
  const ping = (socket: WebSocket, state: { awaiting: boolean }) => {
    try {
      state.awaiting = true;
      socket.ping();
    } catch {
      socket.terminate();
      remove(socket);
    }
  };
  const timer = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (socket.readyState !== 1) continue;
      if (state.awaiting && ++state.missed >= 2) {
        socket.terminate();
        remove(socket);
        continue;
      }
      ping(socket, state);
    }
  }, 30_000);
  timer.unref?.();
  return {
    add(socket: WebSocket) {
      const state = {
        missed: 0,
        awaiting: false,
        pong: () => {
          state.missed = 0;
          state.awaiting = false;
        },
        close: () => remove(socket),
      };
      sockets.set(socket, state);
      socket.on("pong", state.pong);
      socket.on("close", state.close);
      ping(socket, state);
    },
    dispose() {
      clearInterval(timer);
      for (const socket of sockets.keys()) remove(socket);
    },
  };
}

/** Includes sockets still waiting for welcome/readiness, with one absolute close deadline. */
export async function closeSocketsWithin(
  sockets: Iterable<WebSocket>,
  deadline: number,
): Promise<void> {
  await Promise.all(
    [...sockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === 3) {
            resolve();
            return;
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = () => {
            if (timer !== undefined) clearTimeout(timer);
            socket.off("close", finish);
            resolve();
          };
          socket.on("close", finish);
          timer = setTimeout(
            () => {
              socket.terminate();
              finish();
            },
            Math.max(0, deadline - performance.now()),
          );
          try {
            socket.close(1001, "server-shutdown");
          } catch {
            socket.terminate();
            finish();
          }
        }),
    ),
  );
}
