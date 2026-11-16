import { afterEach, expect, it, vi } from "vitest";
import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import { TerminalRecovery, terminalSnapshotReader } from "./terminalRecovery";
const snapshot = (revision = 0, generation = 1, epoch = "backend"): TerminalSessionSnapshot => ({
  epoch,
  generation,
  revision,
  threadId: "thread",
  terminalId: "default",
  cwd: "/repo",
  status: "running",
  pid: 1,
  history: "old",
  exitCode: null,
  exitSignal: null,
  updatedAt: "now",
});
const output = (revision: number, data = "x"): TerminalEvent => ({
  epoch: "backend",
  generation: 1,
  revision,
  threadId: "thread",
  terminalId: "default",
  type: "output",
  data,
  createdAt: "now",
});
afterEach(() => vi.useRealTimers());

it("installs a snapshot then applies clear, output and exit received during its read exactly once", async () => {
  let resolve!: (value: TerminalSessionSnapshot) => void;
  const calls: string[] = [];
  const recovery = new TerminalRecovery(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    () => calls.push("snapshot"),
    (event) => calls.push(event.type),
  );
  const sync = recovery.sync();
  recovery.event({ ...output(1), type: "cleared" });
  recovery.event(output(2));
  recovery.event({ ...output(3), type: "exited", exitCode: 0, exitSignal: null });
  resolve(snapshot());
  await sync;
  recovery.event(output(2));
  expect(calls).toEqual(["snapshot", "cleared", "output", "exited"]);
  recovery.dispose();
});
it("discards snapshots whose buffered events have a gap or a new backend epoch", async () => {
  vi.useFakeTimers();
  let resolve!: (value: TerminalSessionSnapshot) => void;
  const install = vi.fn();
  const read = vi.fn(
    () =>
      new Promise<TerminalSessionSnapshot>((done) => {
        resolve = done;
      }),
  );
  const recovery = new TerminalRecovery(read, install, vi.fn());
  const sync = recovery.sync();
  recovery.event(output(2));
  resolve(snapshot());
  await sync;
  expect(install).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  recovery.event({ ...output(3), epoch: "new-backend" });
  resolve(snapshot(2));
  await Promise.resolve();
  await Promise.resolve();
  expect(install).not.toHaveBeenCalled();
  recovery.dispose();
});
it("invalidates an overflowing attempt and refetches without retaining an unbounded suffix", async () => {
  vi.useFakeTimers();
  let resolve!: (value: TerminalSessionSnapshot) => void;
  const install = vi.fn();
  const read = vi.fn(
    () =>
      new Promise<TerminalSessionSnapshot>((done) => {
        resolve = done;
      }),
  );
  const recovery = new TerminalRecovery(read, install, vi.fn());
  const sync = recovery.sync();
  for (let i = 1; i <= 2001; i++) recovery.event(output(i));
  resolve(snapshot());
  await sync;
  expect(install).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(read).toHaveBeenCalledTimes(2);
  resolve(snapshot(2001));
  await Promise.resolve();
  await Promise.resolve();
  expect(install).toHaveBeenCalledTimes(1);
  recovery.dispose();
});
it("does not install a response from before disconnection", async () => {
  let resolve!: (value: TerminalSessionSnapshot) => void;
  const install = vi.fn();
  const recovery = new TerminalRecovery(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    install,
    vi.fn(),
  );
  const sync = recovery.sync();
  recovery.disconnect();
  resolve(snapshot());
  await sync;
  expect(install).not.toHaveBeenCalled();
  recovery.dispose();
});

it("opens an offline-mounted viewport when synchronization finishes and never reopens it on reconnect", async () => {
  vi.useFakeTimers();
  const read = vi.fn(async () => null);
  const open = vi.fn(async () => snapshot());
  const recovery = new TerminalRecovery(terminalSnapshotReader(read, open), vi.fn(), vi.fn());
  recovery.disconnect();
  await recovery.sync();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  await recovery.connect();
  expect(open).toHaveBeenCalledTimes(1);
  recovery.disconnect();
  await recovery.connect();
  expect(open).toHaveBeenCalledTimes(1);
  recovery.dispose();
});
it("reports open failures, retries the open and cancels polling while disconnected", async () => {
  vi.useFakeTimers();
  const open = vi
    .fn<() => Promise<TerminalSessionSnapshot>>()
    .mockRejectedValueOnce(new Error("bad cwd"))
    .mockResolvedValue(snapshot());
  const error = vi.fn();
  const recovery = new TerminalRecovery(
    terminalSnapshotReader(async () => null, open),
    vi.fn(),
    vi.fn(),
    error,
  );
  await recovery.sync();
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "bad cwd" }));
  recovery.disconnect();
  await vi.advanceTimersByTimeAsync(2000);
  expect(open).toHaveBeenCalledTimes(1);
  await recovery.connect();
  expect(open).toHaveBeenCalledTimes(2);
  recovery.dispose();
});
