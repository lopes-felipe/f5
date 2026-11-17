/** GitHub preview events are hints only; PR state is always re-read through the normal service. */
export interface GitHubPrEventTransport {
  subscribe(signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  open(url: string, signal: AbortSignal): Promise<Response>;
  remove(id: string | number): Promise<void>;
}
export function safeGitHubEventsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = URL.parse(value);
  return url?.origin === "https://api.github.com" && !url.username && !url.password
    ? url.href
    : null;
}
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
/** Returns a cooldown after refusal/exhausted retries; abort always tears down the subscription. */
export async function followGitHubPullRequestEvents(
  transport: GitHubPrEventTransport,
  changed: () => void,
  signal: AbortSignal,
  options: { sleep?: typeof delay; random?: () => number; silenceMs?: number } = {},
): Promise<number> {
  const sleep = options.sleep ?? delay;
  const backoff = (failures: number) =>
    sleep(
      Math.min(60_000, 1000 * 2 ** failures) * (0.5 + (options.random ?? Math.random)() / 2),
      signal,
    );
  let failures = 0;
  while (!signal.aborted) {
    let subscription: { id: string | number; url: string } | null = null;
    let renew = false;
    try {
      const response = await transport.subscribe(signal);
      if (response.status === 403 || response.status === 404) return 60 * 60_000;
      if (response.status === 422) return 10 * 60_000;
      const body = response.body as { id?: unknown; events_url?: unknown } | null;
      const url = safeGitHubEventsUrl(body?.events_url);
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !body ||
        (typeof body.id !== "string" && typeof body.id !== "number")
      )
        return 2 * 60_000;
      if (!url) {
        await transport.remove(body.id).catch(() => {});
        return 2 * 60_000;
      }
      subscription = { id: body.id, url };
      while (!signal.aborted) {
        const openedAt = Date.now();
        let events = 0;
        const connection = new AbortController();
        const aborted = () => connection.abort(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
        let silence: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          clearTimeout(silence);
          silence = setTimeout(
            () => connection.abort(new Error("GitHub event stream silent")),
            options.silenceMs ?? 45_000,
          );
        };
        try {
          arm();
          const response = await transport.open(subscription.url, connection.signal);
          if (response.status === 401 || response.status === 403 || response.status === 404)
            return 60 * 60_000;
          if (response.status !== 200 || !response.body)
            throw new Error("Event connection refused");
          changed(); // Catch up changes that happened before subscribing or during a disconnect.
          const reader = response.body.getReader();
          const stopReader = () => {
            void reader.cancel().catch(() => {});
          };
          connection.signal.addEventListener("abort", stopReader, { once: true });
          if (connection.signal.aborted) stopReader();
          const decoder = new TextDecoder();
          let buffered = "";
          let event = "";
          let data: string[] = [];
          let ended = false;
          let frameSize = 0;
          const dispatch = () => {
            if (event === "github.stream.end") {
              ended = true;
              try {
                renew = JSON.parse(data.join("\n"))?.outcome === "subscription_ended";
              } catch {
                /* Reconnect unknown terminal frames. */
              }
            } else if (data.length > 0) {
              events++;
              changed();
            }
            event = "";
            data = [];
            frameSize = 0;
          };
          try {
            for (;;) {
              const read = await reader.read();
              if (read.done) break;
              arm();
              buffered += decoder.decode(read.value, { stream: true });
              if (buffered.length > 1024 * 1024) throw new Error("Event frame exceeds limit");
              let newline: number;
              while ((newline = buffered.indexOf("\n")) >= 0) {
                const line = buffered.slice(0, newline).replace(/\r$/, "");
                buffered = buffered.slice(newline + 1);
                if (!line) dispatch();
                else if (line.startsWith("event:")) event = line.slice(6).trimStart();
                else if (line.startsWith("data:")) {
                  data.push(line.slice(5).replace(/^ /, ""));
                  frameSize += line.length;
                  if (frameSize > 1024 * 1024) throw new Error("Event frame exceeds limit");
                }
              }
              if (ended || signal.aborted) break;
            }
          } finally {
            connection.signal.removeEventListener("abort", stopReader);
            await reader.cancel().catch(() => {});
          }
        } catch {
          if (signal.aborted) return 0;
        } finally {
          clearTimeout(silence);
          signal.removeEventListener("abort", aborted);
          connection.abort();
        }
        failures = events > 0 || Date.now() - openedAt >= 120_000 ? 0 : failures + 1;
        if (renew) break;
        if (failures > 6) return 2 * 60_000;
        await backoff(failures);
      }
    } catch {
      if (signal.aborted) return 0;
      if (++failures > 6) return 2 * 60_000;
    } finally {
      if (subscription !== null) await transport.remove(subscription.id).catch(() => {});
    }
    if (!signal.aborted) await backoff(failures);
  }
  return 0;
}
