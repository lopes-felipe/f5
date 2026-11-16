import { createServer } from "node:http";
import { Effect, Metric } from "effect";
import { describe, expect, it, vi } from "vitest";
import { resolveOtlpConfiguration } from "@t3tools/shared/observability";
import { makeOtlpTraceSink, otlpMetricsLayer, otlpResource } from "./OtlpExport.ts";
import type { TraceRecord } from "./TraceRecord.ts";

const record: TraceRecord = {
  type: "effect-span",
  name: "bounded-trace",
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  sampled: true,
  kind: "server",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: { fixture: true },
  events: [],
  links: [],
  exit: { _tag: "Success" },
};
describe("otlpResource", () => {
  it("names the host and build, unless OTEL_RESOURCE_ATTRIBUTES already names the host", () => {
    const resource = (attributes: Record<string, string>) =>
      otlpResource("1.2.3", "profile", attributes, "box-1");
    expect(resource({})).toMatchObject({
      serviceName: "f5-server",
      serviceVersion: "1.2.3",
      attributes: { "host.name": "box-1", "f5.profile.id": "profile" },
    });
    expect(resource({ "host.name": "from-env" }).attributes["host.name"]).toBe("from-env");
    expect(resource({ "host.name": "" }).attributes["host.name"]).toBe("box-1");
  });
});
describe("bounded OTLP traces", () => {
  it.each(["http/json", "http/protobuf"])(
    "sends %s to a fake collector with resource metadata",
    async (protocol) => {
      const received: {
        body: Buffer;
        type?: string | undefined;
        authorization?: string | undefined;
        path?: string | undefined;
      }[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.push({
            body: Buffer.concat(chunks),
            path: request.url,
            type: request.headers["content-type"],
            authorization: request.headers.authorization,
          });
          response.writeHead(200).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No collector address");
        const configuration = resolveOtlpConfiguration(
          {
            otlpTracesUrl: `http://127.0.0.1:${address.port}/v1/traces`,
            otlpMetricsUrl: `http://127.0.0.1:${address.port}/v1/metrics`,
            otlpHeaders: [{ name: "Authorization", value: "Bearer private" }],
          },
          { OTEL_EXPORTER_OTLP_PROTOCOL: protocol },
        );
        await Effect.runPromise(
          Effect.gen(function* () {
            const config = resolveOtlpConfiguration(
              {
                otlpTracesUrl: `http://127.0.0.1:${address.port}/v1/traces`,
                otlpHeaders: [{ name: "Authorization", value: "Bearer private" }],
              },
              { OTEL_EXPORTER_OTLP_PROTOCOL: protocol },
            ).traces;
            const sink = yield* makeOtlpTraceSink(config, otlpResource("test", "profile", {}));
            sink.push(record);
            yield* sink.flush;
            expect(sink.statistics().writeFailures).toBe(0);
            yield* Metric.update(Metric.counter("f5_collector_fixture"), 1);
            yield* Effect.promise(() =>
              vi.waitFor(() =>
                expect(
                  received.some(
                    (entry) =>
                      entry.path === "/v1/metrics" && entry.body.includes("f5_collector_fixture"),
                  ),
                ).toBe(true),
              ),
            );
          }).pipe(
            Effect.provide(
              otlpMetricsLayer(configuration.metrics, otlpResource("test", "profile", {}), {
                exportInterval: "10 millis",
              }),
            ),
            Effect.scoped,
          ),
        );
        expect(received.filter((entry) => entry.path === "/v1/traces")).toHaveLength(1);
        expect(received[0]!.type).toContain(
          protocol === "http/json" ? "application/json" : "application/x-protobuf",
        );
        expect(received[0]!.authorization).toBe("Bearer private");
        for (const text of ["bounded-trace", "f5-server", "f5.profile.id", "profile"])
          expect(received[0]!.body.includes(text)).toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
  it("bounds the queue during a blocked request and aborts that request on close", async () => {
    let active = 0;
    let maximum = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          maximum = Math.max(maximum, ++active);
          options?.signal?.addEventListener(
            "abort",
            () => {
              active--;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sink = yield* makeOtlpTraceSink(
          resolveOtlpConfiguration({ otlpTracesUrl: "https://collector.test" }).traces,
          otlpResource("test", undefined, {}),
          fetcher,
        );
        sink.push(record);
        const flushing = Effect.runPromise(sink.flush);
        yield* Effect.promise(() => vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()));
        for (let i = 0; i < 5000; i++) sink.push(record);
        expect(sink.statistics().bufferedRecords).toBeLessThanOrEqual(4096);
        expect(sink.statistics().droppedRecords).toBeGreaterThan(0);
        yield* sink.close();
        yield* Effect.promise(() => flushing);
      }).pipe(Effect.scoped),
    );
    expect(maximum).toBe(1);
    expect(active).toBe(0);
  });
});
