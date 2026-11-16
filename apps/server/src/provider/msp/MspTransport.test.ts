import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { writeAcpWrapper } from "../../testUtils/cli.ts";
import { openMspHost } from "./MspSessionRuntime.ts";
import { makeMspTransport } from "./MspTransport.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockHostPath = path.join(__dirname, "../../../scripts/msp-mock-host.ts");

const wrapper = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "msp-mock-host-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    return yield* Effect.sync(() =>
      writeAcpWrapper(path.join(dir, "fake-muse"), mockHostPath, { env }),
    );
  });

it.layer(NodeServices.layer)("MspTransport", (it) => {
  for (const hangingPipe of [false, true])
    it.effect(
      `drains output after process exit${hangingPipe ? " and bounds an inherited open pipe" : " through EOF"}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const output = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
            const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            const spawner = ChildProcessSpawner.make(() =>
              Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1),
                  exitCode: Deferred.await(exit),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  stdout: Stream.fromQueue(output),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              ),
            );
            const handle = yield* makeMspTransport({
              binaryPath: process.execPath,
              args: [],
              cwd: process.cwd(),
              environment: process.env,
              timings: { pipeCloseGraceMs: hangingPipe ? 50 : 500 },
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
            const incoming = handle.transport.incoming[Symbol.asyncIterator]();
            const finalFrame = incoming.next();
            yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
            yield* Effect.promise(() => handle.exited);
            yield* Queue.offer(output, new TextEncoder().encode('{"method":"turn/completed"}\n'));
            assert.deepEqual(yield* Effect.promise(() => finalFrame), {
              value: '{"method":"turn/completed"}\n',
              done: false,
            });
            if (hangingPipe) {
              const rejected = incoming.next().then(
                () => false,
                () => true,
              );
              assert.isTrue(yield* Effect.promise(() => rejected).pipe(Effect.timeout("1 second")));
            } else {
              yield* Queue.end(output);
              assert.isTrue((yield* Effect.promise(() => incoming.next())).done);
            }
            yield* Effect.promise(async () => handle.transport.close?.());
          }),
        ),
    );

  it.effect(
    "rejects an in-flight request when its host exits and close waits for the child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const binaryPath = yield* wrapper({ MSP_MOCK_EXIT_METHOD: "model/list" });
          const handle = yield* makeMspTransport({
            binaryPath,
            args: ["serve"],
            cwd: process.cwd(),
            environment: process.env,
          });
          const host = yield* Effect.promise(() =>
            openMspHost({ transport: handle.transport, clientVersion: "test" }),
          );
          const request = host.request("model/list", {});
          const settled = request.then(
            () => false,
            () => true,
          );
          yield* Effect.promise(() => handle.exited);
          const rejected = yield* Effect.promise(() => settled).pipe(Effect.timeout("1 second"));
          assert.equal(rejected, true);
          yield* Effect.promise(() => host.close());
          assert.equal((yield* Effect.promise(() => handle.exited)).code, 23);
        }),
      ),
    30_000,
  );

  it.effect(
    "speaks MSP to a spawned host and keeps the stderr tail",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* wrapper({ MSP_MOCK_STDERR: "booting muse\n" });
        const handle = yield* makeMspTransport({
          binaryPath,
          args: ["serve"],
          cwd: process.cwd(),
          environment: process.env,
        });
        const host = yield* Effect.promise(() =>
          openMspHost({ transport: handle.transport, clientVersion: "test" }),
        );
        assert.equal(host.initializeResult.serverInfo.name, "muse-mock");
        const models = yield* Effect.promise(() => host.request("model/list", {}));
        assert.ok(Array.isArray(models.models));
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        assert.include(handle.stderrTail(), "booting muse");
        yield* Effect.promise(() => host.close());
        const exit = yield* Effect.promise(() => handle.exited);
        assert.equal(exit.code, 0);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect(
    "escalates to SIGKILL when the host ignores stdin EOF and SIGTERM",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* wrapper({
          MSP_MOCK_STAY_ALIVE: "1",
          MSP_MOCK_IGNORE_SIGTERM: "1",
        });
        const handle = yield* makeMspTransport({
          binaryPath,
          args: ["serve"],
          cwd: process.cwd(),
          environment: process.env,
          timings: { flushBudgetMs: 50, termAfterMs: 100, killAfterMs: 200 },
        });
        yield* Effect.promise(() =>
          openMspHost({ transport: handle.transport, clientVersion: "test" }),
        );
        const startedAt = Date.now();
        yield* Effect.promise(async () => handle.transport.close?.());
        const exit = yield* Effect.promise(() => handle.exited);
        // Windows has no SIGTERM to ignore: the first signal already terminates.
        if (process.platform !== "win32") assert.isAtLeast(Date.now() - startedAt, 250);
        assert.notEqual(exit.code, 0);
        yield* Effect.promise(async () => {
          await handle.transport.write("{}\n").then(
            () => assert.fail("write after close must fail"),
            (error: Error) => assert.match(error.message, /closed/),
          );
        });
      }).pipe(Effect.scoped),
    30_000,
  );
});
