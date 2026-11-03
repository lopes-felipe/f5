import { expect, it, vi } from "vitest";
import { createUpdateInstaller } from "./updateInstall";
import { assertUpdateCaller } from "./updateIpc";
function fixture() {
  const options = {
    canInstall: () => true,
    confirm: vi.fn(async () => true),
    prepare: vi.fn(async () => true),
    install: vi.fn(),
    recover: vi.fn(async (_message: string) => {}),
    timeoutMs: 10,
  };
  const installer = createUpdateInstaller(options);
  return { options, installer };
}
it("rejects unregistered renderers and subframes", () => {
  const frame = {};
  const event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
  expect(() =>
    assertUpdateCaller(event, () => {
      throw new Error("unregistered");
    }),
  ).toThrow();
  expect(() => assertUpdateCaller({ ...event, senderFrame: {} }, () => true)).toThrow();
  expect(() => assertUpdateCaller(event, () => true)).not.toThrow();
});
it("cancel and a second-window veto preserve the payload", async () => {
  const f = fixture();
  f.options.confirm.mockResolvedValueOnce(false);
  expect(await f.installer.request()).toEqual({ accepted: false, completed: false });
  expect(f.options.prepare).not.toHaveBeenCalled();
  f.options.prepare.mockResolvedValueOnce(false);
  expect(await f.installer.request()).toEqual({ accepted: false, completed: false });
  expect(f.options.install).not.toHaveBeenCalled();
  expect(f.installer.pending).toBe(false);
});
it("runs onPrepared only after cleanup succeeds and before the installer handoff", async () => {
  const order: string[] = [];
  const onPrepared = vi.fn(() => order.push("prepared"));
  const options = {
    canInstall: () => true,
    confirm: vi.fn(async () => true),
    prepare: vi.fn(async () => {
      order.push("cleanup");
      return true;
    }),
    onPrepared,
    install: vi.fn(() => {
      order.push("install");
    }),
    recover: vi.fn(async (_message: string) => {}),
    watchdogEnabled: false,
  };
  const installer = createUpdateInstaller(options);

  options.confirm.mockResolvedValueOnce(false);
  await installer.request();
  options.prepare.mockResolvedValueOnce(false);
  await installer.request();
  options.prepare.mockRejectedValueOnce(new Error("cleanup failed"));
  await installer.request();
  expect(onPrepared).not.toHaveBeenCalled();

  order.length = 0;
  expect(await installer.request()).toEqual({ accepted: true, completed: true });
  expect(order).toEqual(["cleanup", "prepared", "install"]);
});
it("serializes requests and recovers once for thrown plus emitted errors", async () => {
  const f = fixture();
  f.options.install.mockImplementation(() => {
    void f.installer.onError("emitted");
    throw new Error("thrown");
  });
  const first = f.installer.request();
  expect((await f.installer.request()).accepted).toBe(false);
  expect((await first).completed).toBe(false);
  expect(f.options.recover).toHaveBeenCalledTimes(1);
  expect(f.installer.pending).toBe(false);
});
it("recovers a cleanup failure and permits retry", async () => {
  const f = fixture();
  f.options.prepare.mockRejectedValueOnce(new Error("cleanup"));
  await f.installer.request();
  expect(f.options.recover).toHaveBeenCalledWith("cleanup");
  await f.installer.request();
  await f.installer.onError("install");
  expect(f.options.recover).toHaveBeenCalledTimes(2);
});
it("recovers when the process remains alive after quitAndInstall", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    await f.installer.request();
    await vi.advanceTimersByTimeAsync(11);
    expect(f.options.recover).toHaveBeenCalledTimes(1);
    expect(f.installer.pending).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});
it("ignores late check errors while confirmation or shutdown cleanup is pending", async () => {
  let confirmed!: (value: boolean) => void;
  let prepared!: (value: boolean) => void;
  const f = fixture();
  f.options.confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        confirmed = resolve;
      }),
  );
  f.options.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        prepared = resolve;
      }),
  );
  const request = f.installer.request();
  await f.installer.onError("late feed error during confirmation");
  expect(f.options.recover).not.toHaveBeenCalled();
  confirmed(true);
  await vi.waitFor(() => expect(f.options.prepare).toHaveBeenCalledTimes(1));
  await f.installer.onError("late feed error during cleanup");
  expect(f.options.recover).not.toHaveBeenCalled();
  expect(f.options.install).not.toHaveBeenCalled();
  prepared(true);
  expect((await request).completed).toBe(true);
  await f.installer.onError("actual install failure");
  expect(f.options.recover).toHaveBeenCalledTimes(1);
});
