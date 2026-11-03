import { useEffect, useMemo, useRef, useState } from "react";
import type { ComputerAccessPush } from "@t3tools/contracts";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";

/**
 * How long a Codex Chrome session request waits before it asks for attention. Desktop
 * main answers one the profile always allows by itself, and the settled event follows
 * the request within a local round trip, so it should never flash a dialog.
 */
export const AUTO_ANSWER_GRACE_MS = 1_000;

function mayBeAutoAnswered(request: typeof ComputerAccessPush.Type): boolean {
  return request.kind === "chrome-session" && request.chromeSession?.integration === "codex-chrome";
}

/** Deadlines affect attention, never the host's consent decision or retained request history. */
export function usePendingComputerAccessRequests() {
  const requests = useAgentComputerActivityStore((state) => state.requests);
  const [now, setNow] = useState(Date.now);
  const firstSeen = useRef(new Map<string, number>());
  useEffect(() => setNow(Date.now()), [requests]);
  useEffect(() => {
    const seen = firstSeen.current;
    for (const id of seen.keys()) if (!requests[id] || requests[id]?.settled) seen.delete(id);
    const deadlines = Object.values(requests).flatMap((request) => {
      if (!request || request.settled) return [];
      // The clock, not `now`: that state can be much older than this request.
      if (mayBeAutoAnswered(request) && !seen.has(request.requestId))
        seen.set(request.requestId, Date.now());
      const graceEnds = mayBeAutoAnswered(request)
        ? seen.get(request.requestId)! + AUTO_ANSWER_GRACE_MS
        : undefined;
      return [request.expiresAtMs, graceEnds].filter(
        (deadline): deadline is number => deadline !== undefined && deadline > now,
      );
    });
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(...deadlines) - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [requests, now]);
  return useMemo(
    () =>
      Object.values(requests).filter(
        (request): request is typeof ComputerAccessPush.Type =>
          !!request &&
          !request.settled &&
          (request.expiresAtMs === undefined || request.expiresAtMs > now) &&
          (!mayBeAutoAnswered(request) ||
            (firstSeen.current.get(request.requestId) ?? now) + AUTO_ANSWER_GRACE_MS <= now),
      ),
    [requests, now],
  );
}
