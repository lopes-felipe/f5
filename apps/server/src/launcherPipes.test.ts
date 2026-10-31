import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestOrderlyShutdown,
  shutdownOnLauncherLoss,
  watchLauncherParent,
  watchLauncherPipes,
} from "./launcherPipes.ts";

const pipeError = (code: string) => Object.assign(new Error(code), { code });

afterEach(() => {
  vi.useRealTimers();
});

describe("watchLauncherPipes", () => {
  it.each(["EPIPE", "ERR_STREAM_DESTROYED"])("reports a %s as launcher loss", (code) => {
    const stdout = new EventEmitter();
    const onLauncherLost = vi.fn();
    watchLauncherPipes([stdout], onLauncherLost);

    stdout.emit("error", pipeError(code));

    expect(onLauncherLost).toHaveBeenCalledTimes(1);
  });

  it("rethrows unrelated stream errors", () => {
    const stdout = new EventEmitter();
    const onLauncherLost = vi.fn();
    watchLauncherPipes([stdout], onLauncherLost);

    expect(() => stdout.emit("error", pipeError("EACCES"))).toThrow("EACCES");
    expect(onLauncherLost).not.toHaveBeenCalled();
  });
});

describe("watchLauncherParent", () => {
  it("reports launcher loss once the process is reparented", () => {
    vi.useFakeTimers();
    let parentPid = 100;
    const onLauncherLost = vi.fn();
    watchLauncherParent(onLauncherLost, () => parentPid, 1_000);

    vi.advanceTimersByTime(5_000);
    expect(onLauncherLost).not.toHaveBeenCalled();

    parentPid = 1;
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(5_000);
    expect(onLauncherLost).toHaveBeenCalledTimes(1);
  });
});

describe("requestOrderlyShutdown", () => {
  it("runs SIGTERM listeners without sending an OS signal", () => {
    const target = new EventEmitter();
    const onSigterm = vi.fn();
    target.on("SIGTERM", onSigterm);

    requestOrderlyShutdown(target as unknown as NodeJS.Process);

    expect(onSigterm).toHaveBeenCalledWith("SIGTERM");
  });
});

describe("shutdownOnLauncherLoss", () => {
  it("shuts down once across both pipes", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const shutdown = vi.fn();
    shutdownOnLauncherLoss({ streams: [stdout, stderr], watchParent: false, shutdown });

    stdout.emit("error", pipeError("EPIPE"));
    stderr.emit("error", pipeError("EPIPE"));
    stdout.emit("error", pipeError("ERR_STREAM_DESTROYED"));

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
