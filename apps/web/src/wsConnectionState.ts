import { useSyncExternalStore } from "react";

export type WsConnectionPhase = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface WsConnectionState {
  readonly phase: WsConnectionPhase;
  readonly synchronized: boolean;
  readonly synchronizationError: string | null;
  readonly attemptCount: number;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
}

type WsReconnectHandler = () => Promise<void> | void;

const INITIAL_WS_CONNECTION_STATE: WsConnectionState = Object.freeze({
  phase: "connecting" as const,
  synchronized: false,
  synchronizationError: null,
  attemptCount: 0,
  connectedAt: null,
  disconnectedAt: null,
  lastError: null,
  lastErrorAt: null,
});

let currentState = INITIAL_WS_CONNECTION_STATE;
const listeners = new Set<() => void>();
let reconnectHandler: WsReconnectHandler | null = null;

function isoNow(): string {
  return new Date().toISOString();
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeWsConnectionState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function hasStateChanged(nextState: WsConnectionState): boolean {
  return (
    nextState.synchronized !== currentState.synchronized ||
    nextState.synchronizationError !== currentState.synchronizationError ||
    nextState.phase !== currentState.phase ||
    nextState.attemptCount !== currentState.attemptCount ||
    nextState.connectedAt !== currentState.connectedAt ||
    nextState.disconnectedAt !== currentState.disconnectedAt ||
    nextState.lastError !== currentState.lastError ||
    nextState.lastErrorAt !== currentState.lastErrorAt
  );
}

function setWsConnectionState(updater: (state: WsConnectionState) => WsConnectionState): void {
  const nextState = updater(currentState);
  if (!hasStateChanged(nextState)) {
    return;
  }

  currentState = Object.freeze({ ...nextState });
  emitChange();
}

export function getWsConnectionState(): WsConnectionState {
  return currentState;
}

export function useWsConnectionState(): WsConnectionState {
  return useSyncExternalStore(
    subscribeWsConnectionState,
    getWsConnectionState,
    getWsConnectionState,
  );
}

export function reconnectWsTransport(): Promise<void> {
  return Promise.resolve(reconnectHandler?.());
}

export function registerWsTransportReconnectHandler(
  handler: WsReconnectHandler | null,
): () => void {
  reconnectHandler = handler;
  return () => {
    if (reconnectHandler === handler) {
      reconnectHandler = null;
    }
  };
}

export function noteWsConnectionAttempt(): void {
  setWsConnectionState((state) => ({
    ...state,
    phase:
      state.attemptCount === 0 &&
      state.connectedAt === null &&
      state.disconnectedAt === null &&
      state.lastErrorAt === null
        ? "connecting"
        : "reconnecting",
    attemptCount: state.attemptCount + 1,
  }));
}

export function noteWsConnectionOpened(): void {
  setWsConnectionState((state) => ({
    ...state,
    phase: "connected",
    synchronized: false,
    connectedAt: isoNow(),
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
  }));
}

export function noteWsConnectionClosed(): void {
  setWsConnectionState((state) => ({
    ...state,
    phase: state.connectedAt === null ? "disconnected" : "reconnecting",
    synchronized: false,
    disconnectedAt: state.disconnectedAt ?? isoNow(),
  }));
}

export function noteWsConnectionError(message: string): void {
  const trimmedMessage = message.trim();
  if (trimmedMessage.length === 0) {
    return;
  }

  setWsConnectionState((state) => ({
    ...state,
    lastError: trimmedMessage,
    lastErrorAt: isoNow(),
  }));
}

export function resetWsConnectionStateForTests(): void {
  reconnectHandler = null;
  currentState = INITIAL_WS_CONNECTION_STATE;
  emitChange();
}

export function isWsInteractionBlocked(phase: WsConnectionPhase): boolean {
  return phase === "disconnected" || phase === "reconnecting";
}

export function noteWsSynchronized(): void {
  setWsConnectionState((state) =>
    state.phase === "connected"
      ? { ...state, synchronized: true, synchronizationError: null }
      : state,
  );
}
export function noteWsResynchronizing(): void {
  setWsConnectionState((state) => ({ ...state, synchronized: false }));
}
export function useServerMutationsAvailable(): boolean {
  const state = useWsConnectionState();
  return state.phase === "connected" && state.synchronized;
}

export function noteWsSynchronizationError(message: string): void {
  setWsConnectionState((state) => ({
    ...state,
    synchronized: false,
    synchronizationError: message,
  }));
}
