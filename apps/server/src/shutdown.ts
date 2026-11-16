import { Duration, Effect, Exit, Layer, Metric, Option, Scope, ServiceMap } from "effect";
import { createLogger } from "./logger.ts";

type Phase = "admission" | "flush" | "producers" | "drain" | "logs";
interface ShutdownStep {
  readonly name: string;
  readonly phase: Phase;
  readonly after?: ReadonlyArray<string>;
  readonly run: (deadline: number, signal: AbortSignal) => Promise<unknown>;
}
export interface ShutdownResult {
  readonly name: string;
  readonly phase: Phase;
  readonly outcome: "complete" | "failed" | "incomplete";
  readonly durationMs: number;
}
const phases: Phase[] = ["admission", "flush", "producers", "drain", "logs"];
const duration = Metric.timer("f5_shutdown_phase_duration");
const incomplete = Metric.counter("f5_shutdown_incomplete_total");
const logger = createLogger("shutdown");

export class ShutdownRegistry {
  private readonly steps = new Set<ShutdownStep>();
  private running: Promise<ReadonlyArray<ShutdownResult>> | undefined;
  deadline: number | undefined;
  get started() {
    return this.running !== undefined;
  }
  register(step: ShutdownStep) {
    if (this.started) throw new Error("Shutdown registration after admission closed");
    this.steps.add(step);
    return () => {
      this.steps.delete(step);
    };
  }
  run(): Promise<ReadonlyArray<ShutdownResult>> {
    if (this.running) return this.running;
    this.deadline = Date.now() + 1_800;
    this.running = this.finish(this.deadline);
    return this.running;
  }
  private async finish(deadline: number): Promise<ReadonlyArray<ShutdownResult>> {
    const results: ShutdownResult[] = [];
    for (const phase of phases) {
      // Keep the same absolute deadline, reserving final persistence/log time.
      const reserved = phase === "logs" ? 0 : phase === "drain" ? 150 : 450;
      const phaseDeadline = deadline - reserved;
      const remaining = new Set([...this.steps].filter((step) => step.phase === phase));
      while (remaining.size > 0) {
        const ready = [...remaining].filter(
          (step) =>
            !step.after?.some((name) => [...remaining].some((pending) => pending.name === name)),
        );
        if (ready.length === 0) {
          for (const step of remaining) {
            logger.warn("shutdown dependency cycle", { phase, component: step.name });
            results.push({ name: step.name, phase, outcome: "failed", durationMs: 0 });
          }
          break;
        }
        await Promise.all(
          ready.map(async (step) => {
            const started = performance.now();
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let outcome: ShutdownResult["outcome"] = "complete";
            try {
              await Promise.race([
                Promise.resolve().then(() => step.run(phaseDeadline, controller.signal)),
                new Promise<void>((resolve) => {
                  timer = setTimeout(
                    () => {
                      outcome = "incomplete";
                      controller.abort();
                      resolve();
                    },
                    Math.max(0, phaseDeadline - Date.now()),
                  );
                }),
              ]);
            } catch (error) {
              if (!controller.signal.aborted) outcome = "failed";
              logger.warn("shutdown component did not finish", {
                phase,
                component: step.name,
                outcome,
                error: String(error),
              });
            } finally {
              if (timer) clearTimeout(timer);
            }
            const durationMs = performance.now() - started;
            const attributes = { phase, component: step.name };
            Effect.runSync(
              Metric.update(
                Metric.withAttributes(duration, attributes),
                Duration.millis(durationMs),
              ),
            );
            if (outcome !== "complete") {
              Effect.runSync(Metric.update(Metric.withAttributes(incomplete, attributes), 1));
              logger.warn("shutdown work incomplete", { phase, component: step.name, outcome });
            }
            results.push({ name: step.name, phase, outcome, durationMs });
          }),
        );
        for (const step of ready) remaining.delete(step);
      }
    }
    this.steps.clear();
    return results;
  }
}
/** Only work already owned by critical source/drain workers may persist after admission stops. */
export const AcceptedShutdownWork = ServiceMap.Reference<boolean>("f5/shutdown/AcceptedWork", {
  defaultValue: () => false,
});

export class ServerShutdown extends ServiceMap.Service<ServerShutdown, ShutdownRegistry>()(
  "t3/shutdown/ServerShutdown",
) {}
export const ServerShutdownLive = Layer.sync(ServerShutdown, () => new ShutdownRegistry());

/** Optional for isolated services/tests; the production server provides one registry. */
export const registerShutdown = <E, R>(
  name: string,
  phase: Phase,
  work: (deadline: number) => Effect.Effect<unknown, E, R>,
  after?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const coordinator = yield* Effect.serviceOption(ServerShutdown);
    if (Option.isNone(coordinator)) return;
    const services = yield* Effect.services<R>();
    const unregister = coordinator.value.register({
      name,
      phase,
      ...(after ? { after } : {}),
      run: (deadline, signal) => Effect.runPromiseWith(services)(work(deadline), { signal }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(unregister));
  });

/** Owns background subscriptions and retry timers separately from admitted workers. */
export const makeShutdownSourceScope = (name: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make("sequential");
    let stopped = false;
    const stop = Effect.gen(function* () {
      stopped = true;
      yield* Scope.close(scope, Exit.void);
    });
    yield* Effect.addFinalizer(() => stop);
    yield* registerShutdown(name, "admission", () => stop);
    return {
      scope,
      stop,
      get stopped() {
        return stopped;
      },
    };
  });
