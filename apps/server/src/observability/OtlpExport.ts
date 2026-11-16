import { hostname } from "node:os";
import { Duration, Effect, Layer, References, Scope } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as OtlpMetrics from "effect/unstable/observability/OtlpMetrics";
import { entriesToAttributes } from "effect/unstable/observability/OtlpResource";
import {
  OtlpSerialization,
  layerJson,
  layerProtobuf,
} from "effect/unstable/observability/OtlpSerialization";
import type { TraceData } from "effect/unstable/observability/OtlpTracer";
import type { OtlpSignalConfiguration } from "@t3tools/shared/observability";
import { type TraceSink, makeTraceSink } from "./TraceSink.ts";
import type { TraceRecord } from "./TraceRecord.ts";

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
const kinds: Readonly<Record<string, number>> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};
const serializationLayer = (config: OtlpSignalConfiguration) =>
  config.protocol === "http/json" ? layerJson : layerProtobuf;

/** `host.name` keeps servers apart on a shared collector; one set in OTEL_RESOURCE_ATTRIBUTES wins. */
export function otlpResource(
  version: string,
  profileId: string | undefined,
  attributes: Readonly<Record<string, string>>,
  hostName: string = hostname(),
) {
  return {
    serviceName: attributes["service.name"] || "f5-server",
    serviceVersion: version,
    attributes: {
      ...attributes,
      "host.name": attributes["host.name"] || hostName,
      ...(profileId ? { "f5.profile.id": profileId } : {}),
    },
  };
}

/** Own the queue before calling the library serializer: bounded bytes, one fetch, finite shutdown. */
export const makeOtlpTraceSink = (
  config: OtlpSignalConfiguration,
  resource: ReturnType<typeof otlpResource>,
  fetcher: typeof fetch = globalThis.fetch,
): Effect.Effect<TraceSink & Required<Pick<TraceSink, "statistics">>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const serialize = yield* OtlpSerialization;
    const pending = new Set<AbortController>();
    let closed = false;
    return yield* makeTraceSink({
      filePath: "<otlp>",
      maxBytes: MAX_EXPORT_BYTES,
      maxFiles: 1,
      batchWindowMs: 1000,
      writer: {
        async write(batch) {
          if (closed || !config.url) throw new Error("Exporter closed");
          const records = batch.map(
            (chunk) => JSON.parse(new TextDecoder().decode(chunk)) as TraceRecord,
          );
          const data: TraceData = {
            resourceSpans: [
              {
                resource: {
                  attributes: entriesToAttributes(
                    Object.entries({
                      ...resource.attributes,
                      "service.name": resource.serviceName,
                      "service.version": resource.serviceVersion,
                    }),
                  ),
                  droppedAttributesCount: 0,
                },
                scopeSpans: [
                  {
                    scope: { name: "f5-server" },
                    spans: records.map((record) => ({
                      traceId: record.traceId,
                      spanId: record.spanId,
                      parentSpanId: record.parentSpanId,
                      name: record.name,
                      kind: kinds[record.kind] ?? 1,
                      startTimeUnixNano: record.startTimeUnixNano,
                      endTimeUnixNano: record.endTimeUnixNano,
                      attributes: entriesToAttributes(Object.entries(record.attributes)),
                      droppedAttributesCount: 0,
                      events: record.events.map((event) => ({
                        ...event,
                        attributes: entriesToAttributes(Object.entries(event.attributes)),
                        droppedAttributesCount: 0,
                      })),
                      droppedEventsCount: 0,
                      links: record.links.map((link) => ({
                        ...link,
                        attributes: entriesToAttributes(Object.entries(link.attributes)),
                        droppedAttributesCount: 0,
                      })),
                      droppedLinksCount: 0,
                      status: { code: record.exit._tag === "Failure" ? 2 : 1 },
                    })),
                  },
                ],
              },
            ],
          };
          const body = serialize.traces(data);
          if (body._tag !== "Uint8Array" || body.body.byteLength > MAX_EXPORT_BYTES)
            throw new Error("Export exceeds limit");
          const controller = new AbortController();
          pending.add(controller);
          try {
            const response = await fetcher(config.url, {
              method: "POST",
              headers: {
                ...config.headers,
                "content-type": body.contentType ?? "application/x-protobuf",
              },
              body: Buffer.from(body.body),
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
              redirect: "error",
            });
            await response.body?.cancel();
            if (!response.ok) throw new Error("Collector rejected batch");
          } finally {
            pending.delete(controller);
          }
        },
        async close() {
          closed = true;
          for (const controller of pending) controller.abort();
        },
      },
    });
  }).pipe(Effect.provide(serializationLayer(config)));

/** Metric snapshots export serially; neither a stalled collector nor retries retain a snapshot queue. */
export const otlpMetricsLayer = (
  config: OtlpSignalConfiguration,
  resource: ReturnType<typeof otlpResource>,
  options: { readonly exportInterval?: Duration.Input } = {},
): Layer.Layer<never> => {
  if (!config.url) return Layer.empty;
  const client = Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const base = yield* HttpClient.HttpClient;
      return HttpClient.transform(base, (requestEffect, request) => {
        const safeError = () =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: HttpClientRequest.post("http://otlp.invalid"),
              description: "OTLP export failed",
            }),
          });
        if (
          ("contentLength" in request.body ? (request.body.contentLength ?? Infinity) : Infinity) >
          MAX_EXPORT_BYTES
        )
          return Effect.fail(safeError());
        return requestEffect.pipe(Effect.timeout("2 seconds"), Effect.mapError(safeError));
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
  return Layer.effectDiscard(
    OtlpMetrics.make({
      url: config.url,
      headers: config.headers,
      resource,
      exportInterval: options.exportInterval ?? "10 seconds",
      shutdownTimeout: "2 seconds",
    }).pipe(
      // Library diagnostics retain HTTP requests. Do not allow them to print credentials.
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  ).pipe(Layer.provide(client), Layer.provide(serializationLayer(config)));
};
