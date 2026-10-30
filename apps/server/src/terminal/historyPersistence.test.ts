import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { neutralizeInheritedHistory, readTerminalHistory } from "./historyPersistence";
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

const INPUT_RESET =
  "\u001b[?1049h\u001b[<100u\u001b[=0;1u\u001b[?1049l" +
  "\u001b[?1;9;66;67;1000;1002;1003;1004;1005;1006;1015;2004l" +
  "\u001b[?25;1035;1036h\u001b[<100u\u001b[=0;1u\u001b[>4m";

it("leaves plain inherited history unchanged", () => {
  expect(neutralizeInheritedHistory("prompt % ls\n", 5000, TERMINAL_HISTORY_MAX_BYTES)).toBe(
    "prompt % ls\n",
  );
});

it("resets input modes a dead program left on the main screen", () => {
  const history = "prompt \u001b[32mok\u001b[0m\u001b[?25l\u001b[?1003;1006;2004h";
  expect(neutralizeInheritedHistory(history, 5000, TERMINAL_HISTORY_MAX_BYTES)).toBe(
    history + INPUT_RESET,
  );
});

it.each([47, 1047, 1049])("leaves an inherited %i alternate screen", (mode) => {
  const history = `prompt\u001b[?${mode}h\u001b[7;18Hdead app`;
  expect(neutralizeInheritedHistory(history, 5000, TERMINAL_HISTORY_MAX_BYTES)).toBe(
    `${history}\u001b7\u001b[?${mode}l${INPUT_RESET}`,
  );
});

it("exits with the outermost alternate-screen entry still open", () => {
  const history = "main\u001b[?1049hone\u001b[?47htwo";
  expect(neutralizeInheritedHistory(history, 5000, TERMINAL_HISTORY_MAX_BYTES)).toBe(
    `${history}\u001b7\u001b[?1049l${INPUT_RESET}`,
  );
});

it.each([
  ["an explicit exit", "\u001b[?1049hvim\u001b[?1049lprompt"],
  ["a full reset", "\u001b[?1049hvim\u001bcprompt"],
])("does not leave an alternate screen closed by %s", (_name, history) => {
  expect(neutralizeInheritedHistory(history, 5000, TERMINAL_HISTORY_MAX_BYTES)).toBe(
    history + INPUT_RESET,
  );
});

it("reserves the reset inside the line and byte limits", () => {
  const lines = "a\nb\n\u001b[?1049hc\n";
  const byLines = neutralizeInheritedHistory(lines, 3, TERMINAL_HISTORY_MAX_BYTES);
  expect(byLines).toBe(`b\n\u001b[?1049hc\n\u001b7\u001b[?1049l${INPUT_RESET}`);
  expect(byLines.split("\n")).toHaveLength(3);

  const maxBytes = 1024;
  const bytes = neutralizeInheritedHistory("x".repeat(2048) + "\u001b[?2004h", 5000, maxBytes);
  expect(bytes.endsWith(INPUT_RESET)).toBe(true);
  expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(maxBytes);
});
