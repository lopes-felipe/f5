import { createServer } from "node:http";
import { Effect, Layer, Metric } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Otlp from "effect/unstable/observability/Otlp";
import { describe, expect, it, vi } from "vitest";

const spikeCounter = Metric.counter("f5_otlp_library_spike");

describe("installed effect-smol OTLP compatibility", () => {
  for (const protocol of ["http/json", "http/protobuf"] as const) {
    it(`exports traces and metrics with ${protocol} without another dependency`, async () => {
      const requests: Array<{ path: string; type: string | undefined; body: Buffer }> = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests.push({
            path: request.url ?? "",
            type: request.headers["content-type"],
            body: Buffer.concat(chunks),
          });
          response.writeHead(200).end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing collector address.");
        const makeLayer = protocol === "http/json" ? Otlp.layerJson : Otlp.layerProtobuf;
        const layer = makeLayer({
          baseUrl: `http://127.0.0.1:${address.port}`,
          resource: { serviceName: "f5-spike", serviceVersion: "test" },
          tracerExportInterval: "10 millis",
          metricsExportInterval: "10 millis",
          loggerExportInterval: "10 millis",
          shutdownTimeout: "1 second",
          maxBatchSize: 32,
        }).pipe(Layer.provide(FetchHttpClient.layer));
        await Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.void.pipe(
              Effect.withSpan("otlp-library-spike", { attributes: { fixture: true } }),
            );
            yield* Metric.update(spikeCounter, 1);
            yield* Effect.promise(() =>
              vi.waitFor(() => {
                expect(
                  requests.some(
                    (request) =>
                      request.path === "/v1/traces" && request.body.includes("otlp-library-spike"),
                  ),
                ).toBe(true);
                expect(
                  requests.some(
                    (request) =>
                      request.path === "/v1/metrics" &&
                      request.body.includes("f5_otlp_library_spike"),
                  ),
                ).toBe(true);
              }),
            );
          }).pipe(Effect.provide(layer)),
        );
        const expectedType =
          protocol === "http/json" ? "application/json" : "application/x-protobuf";
        for (const request of requests.filter(
          (request) => request.path === "/v1/traces" || request.path === "/v1/metrics",
        )) {
          expect(request.type).toContain(expectedType);
          expect(request.body.includes("f5-spike")).toBe(true);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});
