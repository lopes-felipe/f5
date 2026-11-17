import { describe, expect, it, vi } from "vitest";
import {
  followGitHubPullRequestEvents,
  safeGitHubEventsUrl,
  type GitHubPrEventTransport,
} from "./githubPullRequestEvents";
const url = "https://api.github.com/event-subscriptions/1/events?secret=opaque";
const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
function fixture() {
  const controller = new AbortController();
  const transport: GitHubPrEventTransport = {
    subscribe: vi.fn(async () => ({ status: 201, body: { id: 1, events_url: url } })),
    open: vi.fn(async () => stream()),
    remove: vi.fn(async () => {}),
  };
  return { controller, transport, sleep: vi.fn(async () => {}) };
}
describe("GitHub PR event hints", () => {
  it("accepts only the GitHub API origin before any credential is attached", async () => {
    expect(safeGitHubEventsUrl(url)).toBe(url);
    for (const value of [
      "https://evil.example/events",
      "https://api.github.com.evil.example/events",
      "https://user@api.github.com/events",
      "http://api.github.com/events",
    ])
      expect(safeGitHubEventsUrl(value)).toBeNull();
    const { controller, transport, sleep } = fixture();
    transport.subscribe = vi.fn(async () => ({
      status: 201,
      body: { id: 1, events_url: "https://evil.example/events" },
    }));
    await followGitHubPullRequestEvents(transport, () => {}, controller.signal, { sleep });
    expect(transport.open).not.toHaveBeenCalled();
    expect(transport.remove).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("catches up on open, decodes chunk boundaries and renews an expired subscription", async () => {
    const { controller, transport, sleep } = fixture();
    const changed = vi.fn();
    transport.subscribe = vi
      .fn()
      .mockResolvedValueOnce({ status: 201, body: { id: "first", events_url: url } })
      .mockResolvedValue({ status: 403, body: {} });
    transport.open = vi.fn(async () =>
      stream(
        ": keepalive\r\n\r\nevent: changed\r\nda",
        'ta: {"change":1}\r\n\r\nevent: github.stream.end\ndata: {"outcome":"subscription_ended"}\n\n',
      ),
    );
    expect(
      await followGitHubPullRequestEvents(transport, changed, controller.signal, { sleep }),
    ).toBe(3_600_000);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(transport.remove).toHaveBeenCalledExactlyOnceWith("first");
    expect(transport.subscribe).toHaveBeenCalledTimes(2);
  });
  it("bounds reconnects and backoff while keeping one subscription", async () => {
    const { controller, transport, sleep } = fixture();
    await followGitHubPullRequestEvents(transport, () => {}, controller.signal, {
      sleep,
      random: () => 1,
    });
    expect(transport.open).toHaveBeenCalledTimes(7);
    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    expect(transport.remove).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls.length).toBe(6);
  });
  it("cleans up an idle stream on abort without waiting for a host event", async () => {
    const { controller, transport, sleep } = fixture();
    transport.open = vi.fn(async () => new Response(new ReadableStream()));
    const work = followGitHubPullRequestEvents(transport, () => {}, controller.signal, { sleep });
    await vi.waitFor(() => expect(transport.open).toHaveBeenCalledTimes(1));
    controller.abort();
    await work;
    expect(transport.remove).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("cleans up when abort arrives while opening the stream", async () => {
    const { controller, transport, sleep } = fixture();
    transport.open = vi.fn(async () => {
      controller.abort();
      return new Response(new ReadableStream());
    });
    await followGitHubPullRequestEvents(transport, () => {}, controller.signal, { sleep });
    expect(transport.remove).toHaveBeenCalledExactlyOnceWith(1);
  });
  it.each([
    [403, 3_600_000],
    [404, 3_600_000],
    [422, 600_000],
  ])("backs off refusal %s without opening a stream", async (status, cooldown) => {
    const { controller, transport, sleep } = fixture();
    transport.subscribe = vi.fn(async () => ({ status, body: {} }));
    expect(
      await followGitHubPullRequestEvents(transport, () => {}, controller.signal, { sleep }),
    ).toBe(cooldown);
    expect(transport.open).not.toHaveBeenCalled();
  });
});
