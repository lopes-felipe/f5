import type * as Exit from "effect/Exit";
import { Effect, Tracer } from "effect";

import { type EffectTraceRecord, spanToTraceRecord } from "./TraceRecord.ts";
import { makeTraceSink, type TraceSink } from "./TraceSink.ts";
import { redactExitCredentials, redactUrlCredentials } from "./CredentialRedaction.ts";

export interface LocalFileTracerOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly delegate?: Tracer.Tracer;
  readonly sink?: TraceSink;
}

class LocalFileSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Tracer.AnySpan | undefined;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown>;
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]>;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    private readonly delegate: Tracer.Span,
    private readonly push: (record: EffectTraceRecord) => void,
  ) {
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.status = {
      _tag: "Started",
      startTime: options.startTime,
    };
    this.attributes = new Map();
    this.events = [];
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    const recorded = redactExitCredentials(exit);
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit: recorded,
    };
    this.delegate.end(endTime, recorded);

    if (this.sampled) {
      this.push(spanToTraceRecord(this));
    }
  }

  attribute(key: string, value: unknown): void {
    const recorded =
      (key === "url.full" || key === "url.query") && typeof value === "string"
        ? redactUrlCredentials(value)
        : value;
    this.attributes.set(key, recorded);
    this.delegate.attribute(key, recorded);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    const cause = attributes?.["effect.cause"];
    const nextAttributes =
      typeof cause === "string"
        ? { ...attributes, "effect.cause": redactUrlCredentials(cause) }
        : (attributes ?? {});
    this.events.push([name, startTime, nextAttributes]);
    this.delegate.event(name, startTime, nextAttributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
    this.delegate.addLinks(links);
  }
}

export const makeLocalFileTracer = Effect.fn("makeLocalFileTracer")(function* (
  options: LocalFileTracerOptions,
) {
  const sink =
    options.sink ??
    (yield* makeTraceSink({
      filePath: options.filePath,
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
      batchWindowMs: options.batchWindowMs,
    }));

  const delegate =
    options.delegate ??
    Tracer.make({
      span: (spanOptions) => new Tracer.NativeSpan(spanOptions),
    });

  return Tracer.make({
    span(spanOptions) {
      return new LocalFileSpan(spanOptions, delegate.span(spanOptions), sink.push);
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
});
