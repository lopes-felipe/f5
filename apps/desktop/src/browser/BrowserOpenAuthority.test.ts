import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserOpenAuthority } from "./BrowserOpenAuthority";
import { getSafeBrowserLoginUrl, getSafeExternalUrl } from "./externalUrl";

afterEach(() => vi.useRealTimers());

describe("browser login validation", () => {
  it.each([
    "file:///tmp/file",
    "javascript:alert(1)",
    "ftp://example.com",
    "not a URL",
    "",
    "https://user@example.com",
    "https://user:password@example.com",
    "https://example.com/" + "a".repeat(4096),
  ])("rejects %s", (url) => {
    expect(getSafeBrowserLoginUrl(url)).toBeNull();
  });
  it("accepts only bounded HTTP URLs without userinfo", () => {
    expect(getSafeBrowserLoginUrl("HTTP://EXAMPLE.COM")).toBe("http://example.com/");
    expect(getSafeBrowserLoginUrl("https://localhost:3000/callback?a=b")).toBe(
      "https://localhost:3000/callback?a=b",
    );
    expect(getSafeBrowserLoginUrl(null)).toBeNull();
    expect(getSafeBrowserLoginUrl("https://example.com/" + "a".repeat(4076))).not.toBeNull();
    // Existing external-link behavior is preserved for other desktop entry points.
    expect(getSafeExternalUrl("https://user@example.com")).toBe("https://user@example.com/");
  });
});

function setup() {
  const effects = {
    prompt: vi.fn(
      async (_request: { profileId: string; host: string; url: string; signal: AbortSignal }) => 0,
    ),
    open: vi.fn(async (_url: string) => {}),
    copy: vi.fn((_url: string) => {}),
  };
  return { effects, authority: new BrowserOpenAuthority(effects) };
}

describe("browser open authority", () => {
  it.each([
    [0, "opened"],
    [1, "opened"],
    [2, "copied"],
    [3, "denied"],
  ] as const)("handles button %i as %s", async (button, status) => {
    const { effects, authority } = setup();
    effects.prompt.mockResolvedValue(button);
    expect(await authority.request("personal", "https://example.com/login")).toBe(status);
    expect(effects.open).toHaveBeenCalledTimes(status === "opened" ? 1 : 0);
    expect(effects.copy).toHaveBeenCalledTimes(status === "copied" ? 1 : 0);
  });
  it("remembers only the normalized hostname for the selected profile and app session", async () => {
    const { effects, authority } = setup();
    effects.prompt.mockResolvedValueOnce(1).mockResolvedValue(3);
    expect(await authority.request("work", "https://EXAMPLE.COM/one")).toBe("opened");
    expect(await authority.request("work", "http://example.com:8080/two")).toBe("opened");
    expect(effects.prompt).toHaveBeenCalledTimes(1);
    expect(await authority.request("personal", "https://example.com/")).toBe("denied");
    expect(await authority.request("work", "https://other.example.com/")).toBe("denied");
    authority.cancelProfile("work");
    expect(await authority.request("work", "https://example.com/")).toBe("opened");
    const restarted = new BrowserOpenAuthority(effects);
    expect(await restarted.request("work", "https://example.com/")).toBe("denied");
  });
  it("opens once without remembering, validates before prompting, and catches effect failures", async () => {
    const { effects, authority } = setup();
    expect(await authority.request("p", "file:///tmp/a")).toBe("invalid");
    expect(effects.prompt).not.toHaveBeenCalled();
    await authority.request("p", "https://example.com");
    effects.open.mockRejectedValueOnce(new Error("No browser"));
    expect(await authority.request("p", "https://example.com")).toBe("denied");
    expect(effects.prompt).toHaveBeenCalledTimes(2);
  });
  it("opens an allowed host without waiting behind other hosts' consent", async () => {
    const { effects, authority } = setup();
    effects.prompt.mockResolvedValueOnce(1);
    await authority.request("p", "https://allowed.example.com");
    let answer!: (button: number) => void;
    effects.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const waiting = Array.from({ length: 4 }, () =>
      authority.request("p", "https://new.example.com"),
    );
    expect(await authority.request("p", "https://allowed.example.com/again")).toBe("opened");
    authority.cancelProfile("p");
    answer(3);
    await Promise.all(waiting);
  });
  it("bounds concurrent approved opens per profile without forgetting host consent", async () => {
    vi.useFakeTimers();
    const { effects, authority } = setup();
    effects.prompt.mockResolvedValue(1);
    await authority.request("p", "https://example.com");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => authority.request("p", "https://example.com/again")),
    );
    expect(results.filter((status) => status === "opened")).toHaveLength(9);
    expect(results.filter((status) => status === "busy")).toHaveLength(11);
    expect(effects.open).toHaveBeenCalledTimes(10);
    expect(effects.prompt).toHaveBeenCalledOnce();
    expect(await authority.request("other", "https://example.com")).toBe("opened");
    authority.cancelProfile("p");
    expect(await authority.request("p", "https://example.com")).toBe("busy");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await authority.request("p", "https://example.com")).toBe("opened");
    expect(effects.prompt).toHaveBeenCalledTimes(2);
  });
  it("shows one dialog per profile, queues three, and permits another profile's dialog", async () => {
    const { effects, authority } = setup();
    const answers: Array<(button: number) => void> = [];
    effects.prompt.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const requests = Array.from({ length: 4 }, () => authority.request("p", "https://example.com"));
    expect(await authority.request("p", "https://overflow.com")).toBe("busy");
    expect(effects.prompt).toHaveBeenCalledTimes(1);
    const other = authority.request("other", "https://example.com");
    expect(effects.prompt).toHaveBeenCalledTimes(2);
    answers[0]!(0);
    expect(await requests[0]).toBe("opened");
    await vi.waitFor(() => expect(effects.prompt).toHaveBeenCalledTimes(3));
    authority.cancelProfile("p");
    authority.cancelProfile("other");
    expect(await Promise.all(requests.slice(1))).toEqual(["denied", "denied", "denied"]);
    expect(await other).toBe("denied");
    for (const answer of answers) answer(3);
  });
  it("times out active and queued requests within five minutes and ignores late approvals", async () => {
    vi.useFakeTimers();
    const { effects, authority } = setup();
    let answer!: (button: number) => void;
    effects.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const active = authority.request("p", "https://example.com");
    const queued = authority.request("p", "https://example.com");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(await active).toBe("denied");
    expect(await queued).toBe("denied");
    expect(effects.prompt.mock.calls[0]![0].signal.aborted).toBe(true);
    answer(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(effects.open).not.toHaveBeenCalled();
    effects.prompt.mockResolvedValue(3);
    expect(await authority.request("p", "https://example.com")).toBe("denied");
  });
  it("cancels disconnected backend consent without accepting a late response", async () => {
    const { effects, authority } = setup();
    let answer!: (button: number) => void;
    effects.prompt.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const result = authority.request("p", "https://example.com");
    authority.cancelProfile("p");
    expect(await result).toBe("denied");
    answer(0);
    await vi.waitFor(() => expect(effects.prompt.mock.calls[0]![0].signal.aborted).toBe(true));
    expect(effects.open).not.toHaveBeenCalled();
  });
});
