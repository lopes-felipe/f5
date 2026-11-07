import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Logger, References, Tracer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FileSystem, Path } from "effect";

import type { EffectTraceRecord } from "./TraceRecord.ts";
import { makeLocalFileTracer } from "./LocalFileTracer.ts";
import { makeTraceSink } from "./TraceSink.ts";

const makeTestLayer = (tracePath: string) =>
  Layer.mergeAll(
    Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 10_000,
      }),
    ),
    Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

const readTraceRecords = (tracePath: string): Array<EffectTraceRecord> =>
  fs
    .readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EffectTraceRecord);

describe("LocalFileTracer", () => {
  it.effect("keeps connection credentials out of trace files and delegated spans", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "f5-trace-redaction-" });
        const tracePath = path.join(dir, "traces.ndjson");
        const options = {
          filePath: tracePath,
          maxBytes: 1024 * 1024,
          maxFiles: 2,
          batchWindowMs: 10_000,
        };
        const sink = yield* makeTraceSink(options);
        const delegates: Array<Tracer.NativeSpan> = [];
        const tracer = yield* makeLocalFileTracer({
          ...options,
          sink,
          delegate: Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              delegates.push(span);
              return span;
            },
          }),
        });
        const url = "/ws?wsTicket=ticket-secret&dpop=proof-secret&clientSurface=web";
        yield* Effect.annotateCurrentSpan({
          "url.full": `http://127.0.0.1:3773${url}`,
          "url.query": url.slice(4),
        }).pipe(
          Effect.withSpan("GET", { kind: "server" }),
          Effect.provideService(Tracer.Tracer, tracer),
        );
        yield* Effect.die(new Error(`RequestParseError (GET ${url})`)).pipe(
          Effect.tapCause((cause) => Effect.logError(cause)),
          Effect.withSpan("failed-upgrade"),
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provide(Logger.layer([Logger.tracerLogger], { mergeWithExisting: false })),
          Effect.exit,
        );
        yield* sink.close();
        const written = yield* fs.readFileString(tracePath);
        const exported = delegates.map((span) =>
          JSON.stringify({
            attributes: Object.fromEntries(span.attributes),
            events: span.events.map(([, , attributes]) => attributes),
            exit:
              span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
                ? Cause.pretty(span.status.exit.cause)
                : "",
          }),
        );
        for (const text of [written, ...exported]) {
          assert.notInclude(text, "ticket-secret");
          assert.notInclude(text, "proof-secret");
        }
        assert.include(written, "wsTicket=<redacted>&dpop=<redacted>&clientSurface=web");
        assert.include(exported.join("\n"), "effect.cause");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes nested spans to disk and captures log messages as span events", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({
                "demo.parent": true,
              });
              yield* Effect.logInfo("parent event");
              yield* Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({
                  "demo.child": true,
                });
                yield* Effect.logInfo("child event");
              }).pipe(Effect.withSpan("child-span"));
            }).pipe(Effect.withSpan("parent-span"));

            yield* program.pipe(Effect.provide(makeTestLayer(tracePath)));
          }),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(records.length, 2);

        const parent = records.find((record) => record.name === "parent-span");
        const child = records.find((record) => record.name === "child-span");

        assert.notEqual(parent, undefined);
        assert.notEqual(child, undefined);
        if (!parent || !child) {
          return;
        }

        assert.equal(child.parentSpanId, parent.spanId);
        assert.equal(parent.attributes["demo.parent"], true);
        assert.equal(child.attributes["demo.child"], true);
        assert.equal(
          parent.events.some((event) => event.name === "parent event"),
          true,
        );
        assert.equal(
          child.events.some((event) => event.name === "child event"),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("serializes interrupted spans with an interrupted exit status", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.exit(
            Effect.interrupt.pipe(
              Effect.withSpan("interrupt-span"),
              Effect.provide(makeTestLayer(tracePath)),
            ),
          ),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(records.length, 1);
        assert.equal(records[0]?.name, "interrupt-span");
        assert.equal(records[0]?.exit._tag, "Interrupted");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
