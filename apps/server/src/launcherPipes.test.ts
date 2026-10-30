import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { watchLauncherPipes } from "./launcherPipes.ts";

const pipeError = (code: string) => Object.assign(new Error(code), { code });

describe("watchLauncherPipes", () => {
  it.each(["EPIPE", "ERR_STREAM_DESTROYED"])(
    "reports a %s on either stream once as launcher loss",
    (code) => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const onLauncherLost = vi.fn();
      watchLauncherPipes([stdout, stderr], onLauncherLost);

      stdout.emit("error", pipeError(code));
      stderr.emit("error", pipeError(code));
      stdout.emit("error", pipeError(code));

      expect(onLauncherLost).toHaveBeenCalledTimes(1);
    },
  );

  it("rethrows unrelated stream errors", () => {
    const stdout = new EventEmitter();
    const onLauncherLost = vi.fn();
    watchLauncherPipes([stdout], onLauncherLost);

    expect(() => stdout.emit("error", pipeError("EACCES"))).toThrow("EACCES");
    expect(onLauncherLost).not.toHaveBeenCalled();
  });
});
