import { getHeapStatistics } from "node:v8";
import { Effect, Tracer } from "effect";

const MEBIBYTE = 1024 * 1024;
const SPAN_GROWTH_BYTES = 8 * MEBIBYTE;
const SPIKE_GROWTH_BYTES = 128 * MEBIBYTE;
const SPIKE_WINDOW_SAMPLES = 10;
const SPIKE_COOLDOWN_SAMPLES = 60;
const MAX_RECENT_SPANS = 32;
const MAX_SUSPECTS = 8;

interface SpanGrowth {
  readonly name: string;
  readonly growthBytes: number;
}

/** Process-wide heap deltas include concurrent allocations and garbage collection. */
export function makeHeapAttribution(
  tracer: Tracer.Tracer,
  heapUsed = () => getHeapStatistics().used_heap_size,
) {
  const open = new Set<{ name: string; startHeap: number; startTick: number }>();
  const recent: Array<SpanGrowth & { readonly endTick: number }> = [];
  const samples: number[] = [];
  let tick = 0;
  let cooldown = 0;

  const wrapped = Tracer.make({
    ...(tracer.context ? { context: tracer.context } : {}),
    span(options) {
      const span = tracer.span(options);
      const started = { name: options.name, startHeap: heapUsed(), startTick: tick };
      open.add(started);
      const end = span.end;
      span.end = (endTime, exit) => {
        open.delete(started);
        const growthBytes = heapUsed() - started.startHeap;
        if (growthBytes >= SPAN_GROWTH_BYTES) {
          span.attribute("memory.heap_growth_bytes", growthBytes);
          recent.push({ name: started.name, growthBytes, endTick: tick });
          if (recent.length > MAX_RECENT_SPANS) recent.shift();
        }
        end.call(span, endTime, exit);
      };
      return span;
    },
  });

  const sample = Effect.gen(function* () {
    const heap = heapUsed();
    tick++;
    samples.push(heap);
    if (samples.length > SPIKE_WINDOW_SAMPLES) samples.shift();

    const oldestTick = tick - samples.length;
    // Drop old subscriptions from the suspect set while still measuring them at completion.
    for (const started of open) {
      if (started.startTick >= oldestTick) break;
      open.delete(started);
    }

    if (cooldown > 0) {
      cooldown--;
      return;
    }
    const growthBytes = heap - Math.min(...samples);
    if (growthBytes < SPIKE_GROWTH_BYTES) return;
    cooldown = SPIKE_COOLDOWN_SAMPLES;

    const candidates: SpanGrowth[] = [];
    for (const started of open) {
      candidates.push({ name: started.name, growthBytes: heap - started.startHeap });
    }
    for (const ended of recent) {
      if (ended.endTick >= oldestTick) candidates.push(ended);
    }
    const suspects = candidates
      .filter((span) => span.growthBytes >= SPAN_GROWTH_BYTES)
      .sort((left, right) => right.growthBytes - left.growthBytes)
      .slice(0, MAX_SUSPECTS)
      .map(({ name, growthBytes }) => `${name} +${Math.round(growthBytes / MEBIBYTE)} MB`);
    recent.length = 0;

    yield* Effect.void.pipe(
      Effect.withSpan("server.heap.spike", {
        root: true,
        level: "Warn",
        attributes: {
          heapUsedMb: Math.round(heap / MEBIBYTE),
          growthMb: Math.round(growthBytes / MEBIBYTE),
          suspects,
        },
      }),
    );
  });

  const run = sample.pipe(
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
    Effect.withTracer(tracer),
    Effect.forkScoped,
    Effect.asVoid,
  );

  return { tracer: wrapped, run };
}
