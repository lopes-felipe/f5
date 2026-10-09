import type {
  PreviewAutomationActionGeometry,
  PreviewAutomationOperation,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

/** How long after its last action an agent still counts as "using the browser". */
export const AGENT_BROWSER_ACTIVE_WINDOW_MS = 15_000;

export type AgentBrowserActionStatus = "running" | "succeeded" | "failed" | "interrupted";

export interface AgentBrowserActivity {
  readonly operation: PreviewAutomationOperation;
  readonly status: AgentBrowserActionStatus;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly geometry?: PreviewAutomationActionGeometry;
  readonly url?: string | null;
  readonly title?: string | null;
  readonly thumbnailDataUrl?: string | null;
  /** The user took control; agent actions fail until they resume. */
  readonly paused: boolean;
}

const OBSERVE_OPERATIONS: ReadonlySet<PreviewAutomationOperation> = new Set([
  "status",
  "snapshot",
  "screenshot",
  "waitFor",
]);

export function isObservePreviewOperation(operation: PreviewAutomationOperation): boolean {
  return OBSERVE_OPERATIONS.has(operation);
}

export function isAgentBrowserActive(
  activity: AgentBrowserActivity | undefined,
  now: number,
): boolean {
  if (!activity) return false;
  if (activity.paused || activity.status === "running") return true;
  return now - (activity.completedAt ?? activity.startedAt) < AGENT_BROWSER_ACTIVE_WINDOW_MS;
}

export function describeAgentBrowserAction(activity: AgentBrowserActivity): string {
  if (activity.paused) return "You have control of the browser";
  const verb: Record<PreviewAutomationOperation, string> = {
    status: "Checking the page",
    open: "Opening the preview",
    navigate: "Navigating",
    snapshot: "Reading the page",
    click: "Clicking",
    type: "Typing",
    press: "Pressing a key",
    scroll: "Scrolling",
    evaluate: "Running a script",
    waitFor: "Waiting for the page",
    viewport: "Resizing the viewport",
    screenshot: "Taking a screenshot",
    recordingStart: "Starting a recording",
    recordingStop: "Stopping a recording",
  };
  const base = verb[activity.operation];
  switch (activity.status) {
    case "running":
      return `${base}…`;
    case "failed":
      return `${base} failed`;
    case "interrupted":
      return `${base} was interrupted`;
    case "succeeded":
      return base;
  }
}

interface AgentBrowserActivityStoreState {
  readonly byThreadId: Record<string, AgentBrowserActivity | undefined>;
  readonly start: (threadId: ThreadId, operation: PreviewAutomationOperation) => void;
  readonly finish: (
    threadId: ThreadId,
    status: Exclude<AgentBrowserActionStatus, "running">,
    details?: {
      readonly geometry?: PreviewAutomationActionGeometry | undefined;
      readonly error?: string | undefined;
    },
  ) => void;
  readonly setPage: (threadId: ThreadId, url: string | null, title: string | null) => void;
  readonly setPaused: (threadId: ThreadId, paused: boolean) => void;
  readonly setThumbnail: (threadId: ThreadId, thumbnailDataUrl: string | null) => void;
  readonly remove: (threadId: ThreadId) => void;
}

function update(
  state: AgentBrowserActivityStoreState,
  threadId: ThreadId,
  updater: (current: AgentBrowserActivity | undefined) => AgentBrowserActivity | undefined,
): Pick<AgentBrowserActivityStoreState, "byThreadId"> | AgentBrowserActivityStoreState {
  const key = String(threadId);
  const current = state.byThreadId[key];
  const next = updater(current);
  if (next === current) return state;
  return { byThreadId: { ...state.byThreadId, [key]: next } };
}

export const useAgentBrowserActivityStore = create<AgentBrowserActivityStoreState>()((set) => ({
  byThreadId: {},
  start: (threadId, operation) =>
    set((state) =>
      update(state, threadId, (current) => ({
        ...(current?.thumbnailDataUrl !== undefined
          ? { thumbnailDataUrl: current.thumbnailDataUrl }
          : {}),
        ...(current?.url !== undefined ? { url: current.url, title: current.title ?? null } : {}),
        // Keep the last pointer position visible while the next action resolves its target.
        ...(current?.geometry ? { geometry: current.geometry } : {}),
        operation,
        status: "running",
        startedAt: Date.now(),
        paused: current?.paused ?? false,
      })),
    ),
  finish: (threadId, status, details) =>
    set((state) =>
      update(state, threadId, (current) =>
        current
          ? {
              ...current,
              status,
              completedAt: Date.now(),
              ...(details?.geometry ? { geometry: details.geometry } : {}),
              ...(details?.error ? { error: details.error } : {}),
            }
          : current,
      ),
    ),
  setPage: (threadId, url, title) =>
    set((state) =>
      update(state, threadId, (current) =>
        current && (current.url !== url || current.title !== title)
          ? { ...current, url, title }
          : current,
      ),
    ),
  setPaused: (threadId, paused) =>
    set((state) =>
      update(state, threadId, (current) =>
        current
          ? current.paused === paused
            ? current
            : { ...current, paused }
          : paused
            ? { operation: "status", status: "succeeded", startedAt: Date.now(), paused }
            : current,
      ),
    ),
  setThumbnail: (threadId, thumbnailDataUrl) =>
    set((state) =>
      update(state, threadId, (current) =>
        current && current.thumbnailDataUrl !== thumbnailDataUrl
          ? { ...current, thumbnailDataUrl }
          : current,
      ),
    ),
  remove: (threadId) =>
    set((state) => {
      const key = String(threadId);
      if (!(key in state.byThreadId)) return state;
      const { [key]: _removed, ...byThreadId } = state.byThreadId;
      return { byThreadId };
    }),
}));
