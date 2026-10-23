import { randomUUID } from "node:crypto";
import { Effect, Fiber } from "effect";
import type {
  HtmlPreviewRequest,
  HtmlPreviewHostRequest,
  HtmlPreviewResponse,
  HtmlPreviewResult,
  ThreadId,
} from "@t3tools/contracts";

type Host = { readonly push: (request: HtmlPreviewHostRequest) => Effect.Effect<void> };
const unavailable = (
  message = "Preview unavailable; html_render still works.",
): HtmlPreviewResult => ({ _tag: "Unavailable", message });

/** One authenticated renderer owns each response; disconnects and deadlines retire pending work. */
export function makeHtmlPreviewBroker() {
  const hosts = new Map<string, Host>();
  const pending = new Map<
    string,
    { html: string; hostId: string; finish: (result: HtmlPreviewResult) => void }
  >();
  const unregister = (hostId: string) => {
    hosts.delete(hostId);
    for (const request of pending.values())
      if (request.hostId === hostId) request.finish(unavailable());
  };
  return {
    readInput: (requestId: string) => pending.get(requestId)?.html ?? null,
    register: (hostId: string, host: Host) => {
      hosts.set(hostId, host);
    },
    unregister,
    respond: (hostId: string, response: HtmlPreviewResponse) => {
      const request = pending.get(response.requestId);
      if (request?.hostId === hostId) request.finish(response.result);
    },
    render: (threadId: ThreadId, input: Omit<HtmlPreviewRequest, "requestId" | "threadId">) =>
      Effect.suspend(() => {
        const host = hosts.entries().next().value;
        if (!host) return Effect.succeed(unavailable());
        if (pending.size >= 2)
          return Effect.succeed(unavailable("HTML preview is busy. Retry shortly."));
        const [hostId, owner] = host;
        const requestId = randomUUID();
        return Effect.callback<HtmlPreviewResult>((resume) => {
          const timer = setTimeout(
            () => finish(unavailable("HTML preview timed out after 15 seconds.")),
            15_000,
          );
          const finish = (result: HtmlPreviewResult) => {
            if (!pending.delete(requestId)) return;
            clearTimeout(timer);
            resume(Effect.succeed(result));
          };
          pending.set(requestId, { html: input.html, hostId, finish });
          const fiber = Effect.runFork(
            owner
              .push({
                width: input.width,
                appearance: input.appearance,
                threadId,
                requestId,
                documentPath: `/api/html-renders/preview/${requestId}`,
              })
              .pipe(Effect.catchCause(() => Effect.sync(() => finish(unavailable())))),
          );
          return Effect.sync(() => {
            clearTimeout(timer);
            pending.delete(requestId);
          }).pipe(Effect.andThen(Fiber.interrupt(fiber)));
        });
      }),
    close: () => {
      for (const hostId of hosts.keys()) unregister(hostId);
    },
  };
}
