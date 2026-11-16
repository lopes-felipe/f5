import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { ignoreBrokenPipeErrors } from "./stdioErrors";

it("ignores EPIPE on both streams while surfacing other errors", () => {
  const streams = [new EventEmitter(), new EventEmitter()];
  ignoreBrokenPipeErrors(streams);
  for (const stream of streams) {
    expect(() =>
      stream.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" })),
    ).not.toThrow();
    const error = Object.assign(new Error("disk failure"), { code: "EIO" });
    expect(() => stream.emit("error", error)).toThrow(error);
  }
});
