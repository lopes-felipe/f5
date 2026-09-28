import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readTerminalHistory } from "./historyPersistence";
import { TERMINAL_HISTORY_MAX_BYTES } from "./BoundedTerminalHistory";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function file() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "f5-terminal-history-"));
  directories.push(directory);
  return path.join(directory, "history.log");
}

it("loads only the bounded tail of a large log and returns valid UTF-8", async () => {
  const name = file();
  fs.writeFileSync(name, "🙂".repeat((2 * TERMINAL_HISTORY_MAX_BYTES) / 4) + "é");
  const { history, truncated } = await readTerminalHistory(name, 5000);
  expect(truncated).toBe(true);
  expect(history.byteLength).toBeLessThanOrEqual(TERMINAL_HISTORY_MAX_BYTES);
  expect(history.value()).toBe("🙂".repeat(((TERMINAL_HISTORY_MAX_BYTES - 2) / 4) | 0) + "é");
});

it("restores recent complete lines and preserves CRLF and ANSI", async () => {
  const name = file();
  fs.writeFileSync(name, "old\n\u001b[32m世界\u001b[0m\r\nlast\n");
  const { history, truncated } = await readTerminalHistory(name, 2);
  expect(truncated).toBe(true);
  expect(history.value()).toBe("\u001b[32m世界\u001b[0m\r\nlast\n");
});

it("uses a persistent decoder across short reads and closes the handle", async () => {
  const name = file();
  const original = "\ufeff" + "🙂é世界\r\n".repeat(20);
  fs.writeFileSync(name, original);
  const open = fs.promises.open.bind(fs.promises);
  let close: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(((
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => read(buffer, offset, Math.min(length, 1), position)) as typeof handle.read);
    close = vi.spyOn(handle, "close");
    return handle;
  });
  expect((await readTerminalHistory(name, 5000)).history.value()).toBe(original);
  expect(close).toHaveBeenCalledOnce();
});

it("closes the file on a read failure", async () => {
  const name = file();
  fs.writeFileSync(name, "data");
  const open = fs.promises.open.bind(fs.promises);
  let close: ReturnType<typeof vi.spyOn> | undefined;
  vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    vi.spyOn(handle, "read").mockRejectedValue(new Error("read failed"));
    close = vi.spyOn(handle, "close");
    return handle;
  });
  await expect(readTerminalHistory(name, 5000)).rejects.toThrow("read failed");
  expect(close).toHaveBeenCalledOnce();
});
