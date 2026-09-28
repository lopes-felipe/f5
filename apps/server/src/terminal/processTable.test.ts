import { afterEach, expect, it, vi } from "vitest";
import { runProcess } from "../processRunner";
import { parseTerminalProcessTable, readTerminalProcessTable } from "./processTable";
vi.mock("../processRunner", () => ({ runProcess: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each(["linux", "darwin", "win32"] as const)(
  "reads one bounded process table on %s",
  async (platform) => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      stdout: platform === "win32" ? "20|10\r\n21|10\r\n30|20\r\n" : "20 10\n21 10\n30 20\n",
      stderr: "",
      signal: null,
      timedOut: false,
    });
    expect(await readTerminalProcessTable(platform)).toEqual(new Set([10, 20]));
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(runProcess).toHaveBeenCalledWith(
      platform === "win32" ? "powershell.exe" : "ps",
      expect.any(Array),
      expect.objectContaining({ maxBufferBytes: 1024 * 1024, outputMode: "error" }),
    );
  },
);

it.each(["nonzero exit", "output overflow", "timeout"])(
  "preserves runner failure: %s",
  async (message) => {
    vi.mocked(runProcess).mockRejectedValue(new Error(message));
    await expect(readTerminalProcessTable("win32")).rejects.toThrow(message);
  },
);

it("falls back to a header-bearing POSIX table", async () => {
  vi.mocked(runProcess).mockRejectedValueOnce(new Error("unsupported option"));
  vi.mocked(runProcess).mockResolvedValueOnce({
    code: 0,
    stdout: "  PID  PPID\n20 10\n",
    stderr: "",
    signal: null,
    timedOut: false,
  });
  expect(await readTerminalProcessTable("linux")).toEqual(new Set([10]));
  expect(runProcess).toHaveBeenLastCalledWith("ps", ["-A", "-o", "pid,ppid"], expect.any(Object));
});

it("rejects a failed POSIX fallback", async () => {
  vi.mocked(runProcess).mockRejectedValue(new Error("missing ps"));
  await expect(readTerminalProcessTable("linux")).rejects.toThrow("missing ps");
});

it("rejects malformed tables but accepts a complete table with no children", () => {
  expect(parseTerminalProcessTable("1 0\n", "linux")).toEqual(new Set());
  expect(() => parseTerminalProcessTable("", "linux")).toThrow();
  expect(() => parseTerminalProcessTable("20 bad\n", "linux")).toThrow();
});
