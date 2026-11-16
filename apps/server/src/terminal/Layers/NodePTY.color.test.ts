import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { PtyAdapter } from "../Services/PTY";
import { NodePtyAdapterLive } from "./NodePTY";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn(() => ({ pid: 42 })) }));
vi.mock("node-pty", () => ({ spawn }));
vi.mock("../resolvePtyShell.ts", () => ({
  resolvePtyShell: () => "fake-shell",
  isPtyShellNotFoundError: () => false,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  spawn.mockClear();
});

it.each([
  ["win32", undefined, "xterm-256color"],
  ["win32", "custom-term", "custom-term"],
  ["linux", undefined, undefined],
] as const)(
  "advertises 256 colors on %s while preserving explicit TERM %s",
  async (platform, term, expected) => {
    vi.stubGlobal("process", { ...process, platform });
    const env = { PATH: "/bin", ...(term === undefined ? {} : { TERM: term }) };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* PtyAdapter;
          yield* adapter.spawn({
            shell: "fake-shell",
            args: [],
            cwd: "/",
            cols: 80,
            rows: 24,
            env,
          });
        }).pipe(Effect.provide(NodePtyAdapterLive.pipe(Layer.provide(NodeServices.layer)))),
      ),
    );
    expect(spawn).toHaveBeenCalledWith("fake-shell", [], {
      cwd: "/",
      cols: 80,
      rows: 24,
      name: "xterm-256color",
      env: { ...env, ...(expected === undefined ? {} : { TERM: expected }) },
    });
    expect(env).toEqual({ PATH: "/bin", ...(term === undefined ? {} : { TERM: term }) });
  },
);
