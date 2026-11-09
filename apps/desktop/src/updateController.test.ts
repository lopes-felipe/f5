import { describe, expect, it, vi } from "vitest";
import { createUpdateController } from "./updateController";
import { createInitialDesktopUpdateState } from "./updateMachine";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(
  check = vi.fn(async (): Promise<{ version: string; releaseNotes: null } | null> => null),
  timeoutMs = 1000,
  isQuitting = () => false,
) {
  let state = {
    ...createInitialDesktopUpdateState("0.1.0", {
      hostArch: "x64",
      appArch: "x64",
      runningUnderArm64Translation: false,
    }),
    enabled: true,
    status: "idle" as const,
  } as ReturnType<typeof createInitialDesktopUpdateState>;
  const applySettings = vi.fn();
  const writePreferences = vi.fn();
  const download = vi.fn(async () => {});
  const controller = createUpdateController({
    getState: () => state,
    emit: (next) => {
      state = next;
    },
    writePreferences,
    timeoutMs,
    isQuitting,
    port: { check, download, applySettings },
  });
  return {
    controller,
    check,
    applySettings,
    writePreferences,
    download,
    get state() {
      return state;
    },
    set state(next) {
      state = next;
    },
  };
}
describe("update queue", () => {
  it("restores a cached installer only after the native check finishes", async () => {
    const pending = deferred<{ version: string; releaseNotes: null; cachedDownload: boolean }>();
    const f = fixture(vi.fn(() => pending.promise));
    f.download.mockImplementation(async () => {
      f.state = { ...f.state, status: "downloaded", downloadedVersion: "0.2.0" };
    });
    const check = f.controller.requestCheck("startup");
    await Promise.resolve();
    expect(f.download).not.toHaveBeenCalled();
    pending.resolve({ version: "0.2.0", releaseNotes: null, cachedDownload: true });
    await check;
    expect(f.download).toHaveBeenCalledTimes(1);
    expect(f.state.status).toBe("downloaded");
    expect(f.state.downloadedVersion).toBe("0.2.0");
  });
  it.each([false, true])(
    "keeps uncached updates manual and abandons recovery when quitting (%s)",
    async (quitting) => {
      const f = fixture(
        vi.fn(async () => ({
          version: "0.2.0",
          releaseNotes: null,
          cachedDownload: quitting,
        })),
        1000,
        () => quitting,
      );
      await f.controller.requestCheck("startup");
      expect(f.state.status).toBe("available");
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it("coalesces checks and timestamps completion", async () => {
    const pending = deferred<null>();
    const f = fixture(vi.fn(() => pending.promise));
    const a = f.controller.requestCheck("startup");
    const b = f.controller.requestCheck("menu");
    expect(a).toBe(b);
    await Promise.resolve();
    expect(f.state.checkedAt).toBeNull();
    pending.resolve(null);
    await a;
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(f.state.checkedAt).not.toBeNull();
  });
  it("serializes beta to stable during a check and clears stale versions", async () => {
    const pending = deferred<{ version: string; releaseNotes: null } | null>();
    const check = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(null);
    const f = fixture(check);
    f.state = { ...f.state, channel: "beta" };
    const first = f.controller.requestCheck("menu");
    await Promise.resolve();
    const second = f.controller.setChannel("stable");
    pending.resolve({ version: "0.3.0-beta.1", releaseNotes: null });
    await first;
    await second;
    expect(f.state.channel).toBe("stable");
    expect(f.state.availableVersion).toBeNull();
    expect(check).toHaveBeenCalledTimes(2);
    expect(f.applySettings).toHaveBeenLastCalledWith({
      channel: "latest",
      allowPrerelease: false,
      allowDowngrade: false,
    });
  });
  it("applies rapid toggles in order, rejects obsolete download", async () => {
    const f = fixture();
    f.state = { ...f.state, status: "available", availableVersion: "0.2.0" };
    const beta = f.controller.setChannel("beta");
    const stable = f.controller.setChannel("stable");
    const download = f.controller.download();
    await beta;
    await stable;
    expect((await download).accepted).toBe(false);
    expect(f.writePreferences.mock.calls).toEqual([["beta"], ["stable"]]);
    expect(f.download).not.toHaveBeenCalled();
  });
  it("rejects channel changes while downloading and keeps downloaded payload", async () => {
    const f = fixture();
    f.state = { ...f.state, status: "downloading" };
    expect((await f.controller.setChannel("beta")).accepted).toBe(false);
    f.state = { ...f.state, status: "downloaded", downloadedVersion: "0.2.0" };
    await f.controller.setChannel("beta");
    expect(f.state.downloadedVersion).toBe("0.2.0");
    expect(f.check).not.toHaveBeenCalled();
  });
  it("turns timeout into a retryable error", async () => {
    const f = fixture(
      vi.fn(() => new Promise(() => {})),
      5,
    );
    expect((await f.controller.requestCheck("menu")).completed).toBe(false);
    expect(f.state.status).toBe("error");
    expect(f.state.checkedAt).not.toBeNull();
  });
});

it("persists channel preferences without checking when updates are disabled", async () => {
  const f = fixture();
  f.state = { ...f.state, enabled: false, status: "disabled", message: "Move F5 to Applications" };
  expect((await f.controller.setChannel("beta")).completed).toBe(true);
  expect(f.state.status).toBe("disabled");
  expect(f.state.channel).toBe("beta");
  expect(f.check).not.toHaveBeenCalled();
});

it("drains a timed-out native check before checking the next channel", async () => {
  const pending = deferred<{ version: string; releaseNotes: null } | null>();
  const check = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(null);
  const f = fixture(check, 20);
  await f.controller.requestCheck("startup");
  const switched = f.controller.setChannel("stable");
  await Promise.resolve();
  expect(check).toHaveBeenCalledTimes(1);
  pending.resolve({ version: "0.3.0-beta.1", releaseNotes: null });
  await switched;
  expect(check).toHaveBeenCalledTimes(2);
  expect(f.state.availableVersion).toBeNull();
  expect(f.state.status).toBe("up-to-date");
});
it("keeps background check failures quiet but permits manual check retries", async () => {
  const f = fixture(
    vi.fn(async () => {
      throw new Error("404 https://feed/private headers stack");
    }),
  );
  await f.controller.requestCheck("poll");
  expect(f.state.canRetry).toBe(false);
  expect(f.state.message).toBe("Update information is unavailable. Try again later.");
  await f.controller.requestCheck("menu");
  expect(f.state.canRetry).toBe(true);
});
