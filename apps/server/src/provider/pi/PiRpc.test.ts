import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Schema, Scope, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect, it } from "vitest";
import { writeCliScript } from "../../testUtils/cli.ts";
import { makePiRpcConnection, PiRpcError, PiRpcTimeoutError, type PiRpcOptions } from "./PiRpc.ts";

const source = String.raw`
if(process.env.F5_PI_MOCK_EXIT)process.exit(Number(process.env.F5_PI_MOCK_EXIT));
if(process.env.F5_PI_MOCK_STUBBORN){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
const reply=(record,data)=>process.stdout.write(JSON.stringify({type:'response',id:record.id,command:record.type,success:true,data})+'\n');
let input='';
process.stdin.on('data',chunk=>{
 input+=chunk.toString('utf8');
 for(;;){const end=input.indexOf('\n');if(end<0)break;const line=input.slice(0,end);input=input.slice(end+1);if(!line.trim())continue;
 const record=JSON.parse(line);
 if(record.type==='never')continue;
 if(record.type==='reject'){process.stdout.write(JSON.stringify({type:'response',id:record.id,success:false,error:'PRIVATE_PASSWORD'})+'\n');continue;}
 if(record.type==='flood'){for(let i=0;i<record.count;i++)process.stdout.write(JSON.stringify({type:'notice',text:'x'.repeat(100)})+'\n');reply(record,{});continue;}
 if(record.type==='oversize'){process.stdout.write(JSON.stringify({type:'notice',text:'x'.repeat(record.size)})+'\n');continue;}
 if(record.type==='deep'){process.stdout.write('{"type":"notice","data":'+'['.repeat(100)+'0'+']'.repeat(100)+'}\n');continue;}
 if(record.type==='unicode'){
  process.stdout.write('Pi startup banner\nnot JSON\n');
  const bytes=Buffer.from(JSON.stringify({type:'notice',text:'a\u2028b\u2029c🐈'})+'\r\n');
  for(let i=0;i<bytes.length;i++)process.stdout.write(bytes.subarray(i,i+1));
  reply(record,{ok:true});continue;
 }
 if(record.type==='env'){reply(record,{allowed:process.env.F5_PI_ALLOWED,absent:process.env.F5_PI_PARENT_ONLY??null,args:process.argv.slice(2)});continue;}
 if(record.type==='close_stdout'){process.stdout.end();setInterval(()=>{},1000);continue;}
 setTimeout(()=>reply(record,record.data),record.delay??0);
 }
});
`;
const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>,
) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer)));
const fixture = async <A>(test: (options: PiRpcOptions) => Promise<A>) => {
  const cwd = await mkdtemp(join(tmpdir(), "f5-pi-rpc-"));
  const script = writeCliScript(join(cwd, "pi-mock"), source);
  try {
    return await test({
      command: process.execPath,
      args: [script, "--mode", "rpc", "one argument", "$(literal)"],
      cwd,
      env: { PATH: process.env.PATH, F5_PI_ALLOWED: "kept" },
      terminationGraceMs: 50,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

it("correlates concurrent reordered replies and preserves literal argv and isolated environment", async () =>
  fixture(async (options) => {
    process.env.F5_PI_PARENT_ONLY = "must-not-leak";
    try {
      await run(
        Effect.gen(function* () {
          const rpc = yield* makePiRpcConnection(options);
          const values = yield* Effect.all(
            [
              rpc.request({ type: "echo", data: { n: 1 }, delay: 25 }),
              rpc.request({ type: "echo", data: { n: 2 } }),
            ],
            { concurrency: 2 },
          );
          expect(values).toEqual([{ n: 1 }, { n: 2 }]);
          expect(yield* rpc.request({ type: "env" })).toEqual({
            allowed: "kept",
            absent: null,
            args: ["--mode", "rpc", "one argument", "$(literal)"],
          });
        }),
      );
    } finally {
      delete process.env.F5_PI_PARENT_ONLY;
    }
  }));
it("accepts LF/CRLF with Unicode line separators and ignores non-protocol banners", async () =>
  fixture(async (options) => {
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection(options);
        const event = yield* rpc.events.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
        expect(yield* rpc.request({ type: "unicode" })).toEqual({ ok: true });
        expect(yield* Fiber.join(event)).toEqual([{ type: "notice", text: "a\u2028b\u2029c🐈" }]);
      }),
    );
  }));
it("releases pending admission after timeout and cancellation without stopping the connection", async () =>
  fixture(async (options) => {
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection({ ...options, limits: { pendingRequests: 1 } });
        const timed = yield* rpc.request({ type: "never" }, 20).pipe(Effect.result);
        expect(timed._tag).toBe("Failure");
        if (timed._tag === "Failure")
          expect(Schema.is(PiRpcTimeoutError)(timed.failure)).toBe(true);
        const pending = yield* rpc.request({ type: "never" }).pipe(Effect.forkChild);
        for (let i = 0; i < 8; i++) yield* Effect.yieldNow;
        expect((yield* rpc.request({ type: "echo", data: 1 }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* Fiber.interrupt(pending);
        expect(yield* rpc.request({ type: "echo", data: 2 })).toBe(2);
      }),
    );
  }));
it("retains uncorrelated turn acknowledgements while dropping late timed-out host replies", async () =>
  fixture(async (options) => {
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection(options);
        const records: unknown[] = [];
        const reader = yield* rpc.events.pipe(
          Stream.runForEach((record) =>
            Effect.sync(() => {
              records.push(record);
            }),
          ),
          Effect.forkChild,
        );
        yield* rpc.send({ type: "echo", data: "turn ack" });
        yield* rpc.send({ type: "echo", id: "owned-turn", data: "identified turn ack" });
        yield* rpc
          .request({ type: "echo", data: "late host ack", delay: 50 }, 10)
          .pipe(Effect.result);
        expect(yield* rpc.request({ type: "echo", data: "still alive" })).toBe("still alive");
        yield* Effect.sleep(80);
        expect(records).toEqual([
          { type: "response", command: "echo", success: true, data: "turn ack" },
          {
            type: "response",
            id: "owned-turn",
            command: "echo",
            success: true,
            data: "identified turn ack",
          },
        ]);
        yield* Fiber.interrupt(reader);
      }),
    );
  }));
it("never propagates private provider error payloads", async () =>
  fixture(async (options) => {
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection(options);
        const result = yield* rpc.request({ type: "reject" }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(Schema.is(PiRpcError)(result.failure)).toBe(true);
        expect(JSON.stringify(result)).not.toContain("PRIVATE_PASSWORD");
      }),
    );
  }));
it.each(["frames", "bytes"] as const)(
  "fails the transport instead of retaining unbounded event %s",
  async (kind) =>
    fixture(async (options) => {
      await run(
        Effect.gen(function* () {
          const rpc = yield* makePiRpcConnection({
            ...options,
            limits: kind === "frames" ? { queuedFrames: 2 } : { bufferedBytes: 200 },
          });
          const result = yield* rpc.request({ type: "flood", count: 20 }).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect((yield* rpc.request({ type: "echo" }).pipe(Effect.result))._tag).toBe("Failure");
          yield* rpc.terminate;
        }),
      );
    }),
);
it("fails an oversized unterminated frame and reaps the child", async () =>
  fixture(async (options) => {
    let pid = 0;
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection({ ...options, limits: { frameBytes: 1024 } });
        pid = rpc.pid;
        expect(
          (yield* rpc.request({ type: "oversize", size: 4096 }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    );
    expect(() => process.kill(pid, 0)).toThrow();
  }));
it("rejects oversized or cyclic requests before serialization and keeps the connection usable", async () =>
  fixture(async (options) => {
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection({ ...options, limits: { frameBytes: 1024 } });
        const cycle: Record<string, unknown> = { type: "echo" };
        cycle.self = cycle;
        for (const record of [cycle, { type: "echo", data: "x".repeat(2000) }])
          expect((yield* rpc.request(record).pipe(Effect.result))._tag).toBe("Failure");
        expect(yield* rpc.request({ type: "echo", data: "still ready" })).toBe("still ready");
      }),
    );
  }));
it("rejects excessive JSON depth before parsing provider data", async () =>
  fixture(async (options) => {
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection(options);
        const result = yield* rpc.request({ type: "deep" }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(Schema.is(PiRpcError)(result.failure)).toBe(true);
      }),
    );
  }));
it("reports an immediate process crash before any stdout", async () =>
  fixture(async (options) => {
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection({
          ...options,
          env: { ...options.env, F5_PI_MOCK_EXIT: "23" },
        });
        const result = yield* rpc.request({ type: "echo" }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure.message).toContain("23");
      }),
    );
  }));
it("fails calls when stdout closes even if the child stays alive", async () =>
  fixture(async (options) => {
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection(options);
        expect((yield* rpc.request({ type: "close_stdout" }, 2000).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }),
    );
  }));
it("escalates a stubborn owned process and rejects calls after termination", async () =>
  fixture(async (options) => {
    let pid = 0;
    await run(
      Effect.gen(function* () {
        const rpc = yield* makePiRpcConnection({
          ...options,
          env: { ...options.env, F5_PI_MOCK_STUBBORN: "1" },
        });
        pid = rpc.pid;
        yield* rpc.request({ type: "echo", data: "ready" });
        yield* rpc.terminate;
        expect((yield* rpc.request({ type: "echo" }).pipe(Effect.result))._tag).toBe("Failure");
      }),
    );
    expect(() => process.kill(pid, 0)).toThrow();
  }));

it("reaps a stubborn process when its owning scope is interrupted", async () =>
  fixture(async (options) => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let pid = 0;
    const lifetime = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* makePiRpcConnection({
            ...options,
            env: { ...options.env, F5_PI_MOCK_STUBBORN: "1" },
          });
          pid = rpc.pid;
          yield* rpc.request({ type: "echo", data: "ready" });
          ready();
          return yield* Effect.never;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
      { signal: controller.signal },
    );
    const stopped = lifetime.then(
      () => false,
      () => true,
    );
    await started;
    controller.abort();
    expect(await stopped).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  }));
