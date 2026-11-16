import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type {
  ComputerAuthorization,
  ComputerAutomationRequest,
  ComputerLeaseScope,
  ComputerScreenshot,
} from "@t3tools/contracts";
import { ComputerControlError, computerRequestPayload } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { createRehearsalFixture } from "./rehearsalFixture";
import { closeRehearsalChild } from "./rehearsalCleanup";
import { windowsDiagnosticFailure } from "./rehearsalWindowsDiagnostics";
import type { WindowsFreezeObservation } from "./rehearsalWindowsFreeze";

export type WindowsOperation = ComputerAutomationRequest extends infer R
  ? R extends ComputerAutomationRequest
    ? Omit<R, "requestId" | "payloadHash" | "authorization" | "deadlineAtMs" | "agent">
    : never
  : never;
export type Fixture = Awaited<ReturnType<typeof createRehearsalFixture>>;
export interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WindowReceipt {
  pid: number;
  windowId: number;
  foregroundWindowId: number;
  bounds: NativeRect;
  marker: NativeRect;
  secure: NativeRect;
  dpi: number;
  displays: { displayId: string; bounds: NativeRect; rotation: number }[];
  receipt: { presses: number; inputEvents: number; secureEvents: number; overflow: boolean };
}
export const acceptanceAssert: (value: unknown, code: string) => asserts value = (value, code) => {
  if (!value) throw new Error(code);
};
export const acceptanceWait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export async function acceptanceUntil(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    acceptanceAssert(Date.now() < deadline, "acceptance-timeout");
    await acceptanceWait(20);
  }
}
export class WindowsRefusalMismatch extends Error {
  constructor(
    readonly expected: ComputerControlError["error"]["_tag"],
    readonly actual: ReturnType<typeof windowsDiagnosticFailure>,
  ) {
    super("unexpected-refusal");
  }
}
export async function expectWindowsRefusal(
  run: () => Promise<unknown>,
  tag: ComputerControlError["error"]["_tag"],
) {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof ComputerControlError && error.error._tag === tag))
      throw new WindowsRefusalMismatch(tag, windowsDiagnosticFailure(error));
    return;
  }
  throw new Error("expected-refusal-missing");
}
function windowReceipt(value: unknown): value is WindowReceipt {
  if (!value || typeof value !== "object") return false;
  const v = value as WindowReceipt;
  const rect = (r: NativeRect) =>
    r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  return (
    Number.isSafeInteger(v.pid) &&
    v.pid > 0 &&
    Number.isSafeInteger(v.windowId) &&
    v.windowId > 0 &&
    Number.isSafeInteger(v.foregroundWindowId) &&
    v.foregroundWindowId > 0 &&
    rect(v.bounds) &&
    rect(v.marker) &&
    rect(v.secure) &&
    Number.isFinite(v.dpi) &&
    v.dpi >= 96 &&
    v.receipt?.overflow === false &&
    [v.receipt.presses, v.receipt.inputEvents, v.receipt.secureEvents].every(
      Number.isSafeInteger,
    ) &&
    Array.isArray(v.displays) &&
    v.displays.length > 0 &&
    v.displays.length <= 32 &&
    v.displays.every(
      (d) =>
        typeof d.displayId === "string" &&
        d.displayId.length <= 200 &&
        rect(d.bounds) &&
        [0, 90, 180, 270].includes(d.rotation),
    )
  );
}
/** One outstanding fixture command, bounded receipts, no editable/secure text. */
export class WindowsFixtureObserver {
  private buffer = "";
  private pending: { done: (v: WindowReceipt) => void; fail: () => void } | undefined;
  private failed = false;
  constructor(readonly fixture: Fixture) {
    fixture.child.stdout.on("data", this.read);
    fixture.child.once("exit", this.fail);
    fixture.child.stdin.on("error", this.fail);
  }
  private fail = () => {
    this.failed = true;
    this.pending?.fail();
  };
  private read = (chunk: string | Buffer) => {
    this.buffer += chunk.toString();
    if (this.buffer.length > 16384) {
      this.fail();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.startsWith("FIXTURE_")) continue;
      try {
        const message = JSON.parse(line) as { kind: string; state: unknown };
        if (message.kind === "observation") {
          if (!windowReceipt(message.state) || !this.pending) {
            this.fail();
            return;
          }
          this.pending.done(message.state);
        } else if (message.kind === "invalid-command") this.fail();
      } catch {
        this.fail();
      }
    }
  };
  async command(command = "status"): Promise<WindowReceipt> {
    acceptanceAssert(!this.failed && !this.pending, "fixture-observer-unavailable");
    // The fixture independently parses the same closed command vocabulary.
    acceptanceAssert(
      /^(status|fullscreen|restore|replace-input|place -?\d{1,6} -?\d{1,6})$/.test(command),
      "fixture-command-invalid",
    );
    return new Promise((done, fail) => {
      const timer = setTimeout(() => this.fail(), 3000);
      const finish = () => {
        clearTimeout(timer);
        this.pending = undefined;
      };
      this.pending = {
        done: (value) => {
          finish();
          done(value);
        },
        fail: () => {
          finish();
          fail(new Error("fixture-observation-failed"));
        },
      };
      this.fixture.child.stdin.write(command + "\n");
    });
  }
  close() {
    this.fail();
    this.fixture.child.stdout.off("data", this.read);
    this.fixture.child.off("exit", this.fail);
    this.fixture.child.stdin.off("error", this.fail);
  }
}

export class WindowsAcceptanceSession {
  readonly helper: ComputerHelperClient;
  readonly fixtures: Fixture[] = [];
  readonly observers: WindowsFixtureObserver[] = [];
  readonly checks: Record<string, boolean> = {};
  readonly diagnostics: { freeze?: WindowsFreezeObservation } = {};
  readonly generations = new Map<number, ComputerLeaseScope>();
  readonly host = { f5Pids: [process.pid], f5BundlePath: "", overlayWindowIds: [] as number[] };
  authorization: ComputerAuthorization = {
    profileId: "windows-acceptance",
    threadId: randomUUID(),
    sessionGeneration: randomUUID(),
    turnId: "synthetic-acceptance",
    executionGeneration: 1,
    grantVersion: 1,
    grants: [],
  };
  interrupted = false;
  private renewal: ReturnType<typeof setInterval>;
  private off: () => void;
  private constructor(
    readonly helperPath: string,
    readonly prepared: string,
    readonly root: string,
  ) {
    this.helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
    this.host.f5BundlePath = join(root, "protected-f5");
    this.off = this.helper.onEvent((event) => {
      if (event.type === "physicalInput" || event.type === "killSwitch") this.interrupted = true;
    });
    this.renewal = setInterval(() => {
      if (!this.interrupted)
        for (const executionGeneration of this.generations.keys())
          this.helper.control({ type: "permit", executionGeneration, expiresInMs: 1000 });
    }, 250);
  }
  static async create(helperPath: string, prepared: string) {
    acceptanceAssert(process.platform === "win32", "windows-required");
    return new WindowsAcceptanceSession(
      helperPath,
      prepared,
      await mkdtemp(join(tmpdir(), "f5-windows-acceptance-")),
    );
  }
  async start() {
    this.helper.start();
    await acceptanceUntil(() => this.helper.status().available);
    this.publish();
  }
  publish() {
    this.helper.control({ type: "grantsChanged", authorization: this.authorization });
  }
  async fixture(name: string, ungranted = false) {
    acceptanceAssert(/^[a-z-]{1,30}$/.test(name), "fixture-name-invalid");
    const fixture = await createRehearsalFixture({
      root: this.root,
      appId: join(this.root, name, "ComputerControlFixture.exe").toLowerCase(),
      preparedDirectory: this.prepared,
      ...(ungranted ? { ungranted: true } : {}),
    });
    this.fixtures.push(fixture);
    const observer = new WindowsFixtureObserver(fixture);
    this.observers.push(observer);
    return { fixture, observer, appId: fixture.executable.toLowerCase() };
  }
  grant(apps: readonly string[]) {
    this.authorization = {
      ...this.authorization,
      grantVersion: this.authorization.grantVersion + 1,
      grants: apps.map((appId) => ({ appId, tier: "full", allowTyping: false })),
    };
    this.publish();
  }
  arm(id: number, scope: ComputerLeaseScope) {
    acceptanceAssert(!this.interrupted, "physical-interruption");
    this.authorization = { ...this.authorization, executionGeneration: id };
    this.generations.set(id, scope);
    this.helper.control({ type: "permit", executionGeneration: id, expiresInMs: 1000, scope });
    this.helper.control({ type: "resume", executionGeneration: id, scope });
  }
  async retire(id: number) {
    this.generations.delete(id);
    await this.helper.suspend(id);
    this.helper.control({ type: "retire", executionGeneration: id });
  }
  async request<T = unknown>(operation: WindowsOperation, auth = this.authorization): Promise<T> {
    acceptanceAssert(!this.interrupted, "physical-interruption");
    const envelope = {
      ...operation,
      authorization: auth,
      requestId: randomUUID(),
      deadlineAtMs: Date.now() + 9000,
      agent: { provider: "codex" as const, threadTitle: "Synthetic Windows acceptance" },
    };
    return (await this.helper.request(
      {
        ...envelope,
        payloadHash: createHash("sha256").update(computerRequestPayload(envelope)).digest("hex"),
      } as ComputerAutomationRequest,
      this.host,
    )) as T;
  }
  async verify(image: ComputerScreenshot, secureRects: readonly NativeRect[] = []) {
    return await new Promise<Record<string, number | boolean>>((done, fail) => {
      const verifier = execFile(
        join(this.prepared, "ComputerControlFixture.exe"),
        ["--verify-capture"],
        { timeout: 10000, maxBuffer: 4096, windowsHide: true },
        (error, stdout) => {
          if (error) {
            fail(new Error("pixel-verifier-failed"));
            return;
          }
          try {
            done(JSON.parse(stdout) as Record<string, number | boolean>);
          } catch {
            fail(new Error("pixel-verifier-invalid"));
          }
        },
      );
      verifier.stdin?.on("error", () => fail(new Error("pixel-verifier-disconnected")));
      verifier.stdin?.end(
        JSON.stringify({ data: image.data, mimeType: image.mimeType, secureRects }),
      );
    });
  }
  async close() {
    clearInterval(this.renewal);
    this.off();
    this.observers.forEach((observer) => observer.close());
    const helperClosed = await this.helper.closeAndWait();
    const fixturesClosed = await Promise.all(
      this.fixtures.map((fixture) => closeRehearsalChild(fixture.child)),
    );
    const confirmed = helperClosed && fixturesClosed.every(Boolean);
    if (confirmed) await rm(this.root, { recursive: true, force: true });
    return { confirmed, helperClosed, fixturesClosed: fixturesClosed.every(Boolean) };
  }
}

/** Raw reports retain only assertion names, booleans, artifact identity and cleanup. */
export async function runWindowsAcceptance(
  scope: string,
  run: (session: WindowsAcceptanceSession) => Promise<void>,
) {
  const args = process.argv.slice(2);
  const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const helper = arg("--helper"),
    prepared = arg("--fixture-bin-dir"),
    output = arg("--output");
  acceptanceAssert(
    process.env.F5_COMPUTER_WINDOWS_REHEARSAL === "1" && helper && prepared && output,
    "coordinated-windows-rehearsal-required",
  );
  await writeFile(resolve(output), "", { flag: "wx", mode: 0o600 });
  const session = await WindowsAcceptanceSession.create(helper, prepared);
  let failure = false;
  let failureCode = "acceptance-failed";
  let refusal:
    | { expected: string; actual: ReturnType<typeof windowsDiagnosticFailure> }
    | undefined;
  const interrupt = () => {
    session.interrupted = true;
    session.helper.control({ type: "suspend" });
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await run(session);
  } catch (error) {
    failure = true;
    // Only our fixed assertion vocabulary is publishable, never Windows errors.
    if (error instanceof ComputerControlError) failureCode = error.error._tag;
    else if (error instanceof Error && /^[a-z][a-z-]{1,80}$/.test(error.message))
      failureCode = error.message;
    if (error instanceof WindowsRefusalMismatch)
      refusal = { expected: error.expected, actual: error.actual };
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    const cleanup = await session.close();
    const passed = !failure && !session.interrupted && cleanup.confirmed;
    await writeFile(
      resolve(output),
      JSON.stringify(
        {
          reportVersion: 1,
          platform: process.platform,
          arch: process.arch,
          admissionId: process.env.F5_COMPUTER_CERTIFICATION_ADMISSION,
          recordedAt: new Date().toISOString(),
          helperSha256: createHash("sha256")
            .update(await readFile(helper))
            .digest("hex"),
          state: passed ? "passed" : "failed",
          scope,
          checks: session.checks,
          diagnostics: session.diagnostics,
          ...(failure ? { failure: failureCode } : {}),
          ...(refusal ? { refusal } : {}),
          physicalInterruption: session.interrupted,
          cleanup,
          limitations: [
            "Unsigned native helper evidence; provider consent, persisted activity, signed installation and hardware transition proofs are separate.",
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (!passed) process.exitCode = 1;
  }
}
