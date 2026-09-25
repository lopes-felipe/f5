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

it("rejects a failed or truncated snapshot instead of reporting idle", async () => {
  vi.mocked(runProcess).mockResolvedValue({
    code: 1,
    stdout: "",
    stderr: "denied",
    signal: null,
    timedOut: false,
  });
  await expect(readTerminalProcessTable()).rejects.toThrow();
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    stdout: "20 10",
    stderr: "",
    signal: null,
    timedOut: false,
    stdoutTruncated: true,
  });
  await expect(readTerminalProcessTable()).rejects.toThrow();
  vi.mocked(runProcess).mockRejectedValue(new Error("timeout"));
  await expect(readTerminalProcessTable()).rejects.toThrow("timeout");
});

it("rejects malformed tables but accepts a complete table with no children", () => {
  expect(parseTerminalProcessTable("1 0\n", "linux")).toEqual(new Set());
  expect(() => parseTerminalProcessTable("", "linux")).toThrow();
  expect(() => parseTerminalProcessTable("20 bad\n", "linux")).toThrow();
});
