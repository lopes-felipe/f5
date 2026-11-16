import { afterEach, describe, expect, it, vi } from "vitest";
import { McpReadCoordinator } from "./McpReadCoordinator.ts";

afterEach(() => vi.useRealTimers());
describe("MCP read admission", () => {
  it("coalesces concurrent reads and immediately forgets settled reads", async () => {
    const reads = new McpReadCoordinator();
    let settle!: (value: string) => void;
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );
    const a = reads.read("identity", read);
    const b = reads.read("identity", read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    settle("ready");
    expect(await a).toBe("ready");
    expect(await b).toBe("ready");
    expect(await reads.read("identity", async () => "fresh")).toBe("fresh");
  });
  it("retains uncancellable SDK reads after the caller times out", async () => {
    vi.useFakeTimers();
    const reads = new McpReadCoordinator();
    let settle!: (value: number) => void;
    const sdk = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          settle = resolve;
        }),
    );
    const first = reads.read("query", sdk, 5000);
    const rejected = expect(first).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    const second = reads.read("query", sdk);
    await Promise.resolve();
    expect(sdk).toHaveBeenCalledTimes(1);
    settle(2);
    expect(await second).toBe(2);
  });
  it("reserves capacity for Codex when Claude SDK calls never settle", async () => {
    vi.useFakeTimers();
    const reads = new McpReadCoordinator();
    const hung = () => new Promise<never>(() => {});
    const a = expect(reads.read("claude-a", hung, 5000, "claude")).rejects.toThrow("timed out");
    const b = expect(reads.read("claude-b", hung, 5000, "claude")).rejects.toThrow("timed out");
    await expect(reads.read("claude-c", hung, 5000, "claude")).rejects.toThrow(
      "temporarily unavailable",
    );
    await vi.advanceTimersByTimeAsync(5001);
    await Promise.all([a, b]);
    expect(await reads.read("codex", async () => "ready")).toBe("ready");
    reads.dispose();
  });
  it("rejects overload while permitting coalescing", async () => {
    const reads = new McpReadCoordinator();
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const all = [0, 1, 2, 3].map((index) => reads.read(String(index), () => pending));
    await expect(reads.read("fifth", async () => {})).rejects.toThrow("temporarily unavailable");
    const coalesced = reads.read("0", () => pending);
    settle();
    await Promise.all([...all, coalesced]);
  });
  it("stops admission after disposal", async () => {
    const reads = new McpReadCoordinator();
    reads.dispose();
    await expect(reads.read("late", async () => {})).rejects.toThrow("temporarily unavailable");
  });
});

it("bounds coalesced callers to sixty-four tracked reads", async () => {
  const reads = new McpReadCoordinator();
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const callers = Array.from({ length: 64 }, () => reads.read("same", () => pending));
  await expect(reads.read("same", () => pending)).rejects.toThrow("temporarily unavailable");
  settle();
  await Promise.all(callers);
});
it("aborts traversal on disposal and discards a late result", async () => {
  const reads = new McpReadCoordinator();
  let settle!: () => void;
  let signal!: AbortSignal;
  const pending = reads.read("active", (observedSignal) => {
    signal = observedSignal;
    return new Promise<void>((resolve) => {
      settle = resolve;
    });
  });
  await Promise.resolve();
  reads.dispose();
  expect(signal.aborted).toBe(true);
  settle();
  await expect(pending).rejects.toThrow("disposed");
});
