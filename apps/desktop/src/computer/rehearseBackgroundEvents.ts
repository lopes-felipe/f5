import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { release } from "node:os";
import { Schema } from "effect";
import { ComputerInspectResult, ComputerAutomationRequest } from "@t3tools/contracts";
import { appTier, BACKGROUND_EVENT_CANDIDATES } from "@t3tools/shared/computerApps";
import { ComputerControlError, computerRequestPayload } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";

// Prepare a disposable, scrollable document, select text in its field, then switch to another
// app before running. This inserts one "x"; it never sends Enter, launches apps or restores focus.
const args = process.argv.slice(2);
const arg = (key: string) => (args.includes(key) ? args[args.indexOf(key) + 1] : undefined);
const executable = arg("--helper");
const appId = arg("--app");
const output = arg("--output");
const platform = process.platform;
if (
  (platform !== "darwin" && platform !== "win32") ||
  !executable ||
  !appId ||
  !output ||
  process.env.F5_COMPUTER_BACKGROUND_EVENTS_REHEARSAL !== "1" ||
  !BACKGROUND_EVENT_CANDIDATES[platform].includes(appId)
)
  throw new Error(
    "Use an interactive desktop, F5_COMPUTER_BACKGROUND_EVENTS_REHEARSAL=1, --helper <debug helper>, --app <candidate id>, --output <new report.json>. Prepare a disposable scrollable document and leave its app first.",
  );
await writeFile(resolve(output), "", { flag: "wx", mode: 0o600 });
const helper = new ComputerHelperClient(
  dirname(resolve(executable)),
  resolve(executable),
  Date.now,
  ["--rehearse-background-events=" + appId],
);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const checks: Record<string, boolean> = {};
let failure: string | undefined;
let interrupted = false;
const foreground = new Set<string>();
const off = helper.onEvent((event) => {
  if (event.type === "heartbeat" && typeof event.frontmostAppId === "string")
    foreground.add(event.frontmostAppId);
  if (
    [
      "physicalInput",
      "targetInterrupted",
      "activationIncident",
      "permitExpired",
      "killSwitch",
    ].includes(String(event.type))
  )
    interrupted = true;
});
const tier = appTier(appId, platform);
const authorization = {
  profileId: "background-events-rehearsal",
  threadId: randomUUID(),
  sessionGeneration: randomUUID(),
  turnId: randomUUID(),
  executionGeneration: 1,
  grantVersion: 1,
  grants: [
    {
      appId,
      tier: tier === "click" ? ("click" as const) : ("full" as const),
      allowTyping: tier === "click",
    },
  ],
};
const scope = { kind: "app" as const, appId };
let renewal: ReturnType<typeof setInterval> | undefined;
const invoke = async (input: Record<string, unknown> & { op: ComputerAutomationRequest["op"] }) => {
  if (interrupted) throw new Error("physical-interruption");
  const payload = {
    ...input,
    delivery: "background",
    appId,
    requestId: randomUUID(),
    authorization,
    deadlineAtMs: Date.now() + 10_000,
    agent: { provider: "codex", threadTitle: "Background event rehearsal" },
  };
  const { payloadHash: _placeholder, ...normalized } = Schema.decodeUnknownSync(
    ComputerAutomationRequest,
  )({
    ...payload,
    payloadHash: "0".repeat(64),
  });
  return helper.request(
    {
      ...normalized,
      payloadHash: createHash("sha256").update(computerRequestPayload(normalized)).digest("hex"),
    },
    { f5Pids: [process.pid], f5BundlePath: dirname(resolve(executable)), overlayWindowIds: [] },
  );
};
try {
  helper.start();
  const deadline = performance.now() + 5000;
  while (!helper.status().available && performance.now() < deadline) await wait(50);
  const status = helper.status();
  if (!status.available) throw new Error("helper-" + status.reason);
  if (!helper.capabilities().includes("background-events-v1"))
    throw new Error("missing-events-capability");
  const readiness = await helper.watch(appId, authorization.threadId);
  if (
    readiness.frontmost ||
    !readiness.monitorHealthy ||
    readiness.inputHeld ||
    (readiness.lastActivityAgeMs >= 0 && readiness.lastActivityAgeMs < 1500)
  )
    throw new Error("target-not-idle");
  helper.control({ type: "grantsChanged", authorization });
  helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000, scope });
  helper.control({ type: "resume", executionGeneration: 1, scope });
  renewal = setInterval(() => {
    if (!interrupted) helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000 });
  }, 250);
  await wait(500);
  foreground.clear();
  for (const [name, input] of [
    ["keyChordChanged", { op: "key", chords: ["Shift+Left"], repeat: 1 }],
    ["textKeyChanged", { op: "key", chords: ["x"], repeat: 1 }],
  ] as const) {
    const result = (await invoke(input)) as { verification?: { verified?: boolean } };
    checks[name] = result.verification?.verified === true;
    if (!checks[name]) throw new Error(name + "-unverified");
  }
  const tree = Schema.decodeUnknownSync(ComputerInspectResult)(
    await invoke({ op: "inspect", maxNodes: 400 }),
  );
  const scroll = tree.nodes.find(
    (node) => /scrollarea|scrollpane|document|list/i.test(node.role) && node.enabled,
  );
  if (!scroll) throw new Error("no-scroll-target");
  const result = (await invoke({
    op: "scroll",
    snapshotId: tree.snapshotId,
    elementRef: scroll.elementRef,
    deltaX: 0,
    deltaY: 10,
  })) as { verification?: { verified?: boolean } };
  checks.elementScrollChanged = result.verification?.verified === true;
  await wait(600); // Includes the native activation attribution window and two heartbeats.
  checks.foregroundUnchanged = foreground.size === 1 && !foreground.has(appId);
  checks.noInterruption = !interrupted;
  checks.noInterruption &&= (await helper.availability()).inputSequence === readiness.inputSequence;
} catch (error) {
  failure =
    error instanceof ComputerControlError
      ? error.error._tag
      : error instanceof Error
        ? error.message
        : "rehearsal-failed";
} finally {
  clearInterval(renewal);
  await helper.suspend(1).catch(() => undefined);
  helper.control({ type: "watchRelease", appId, owner: authorization.threadId });
  off();
  helper.close();
  const passed =
    !failure &&
    [
      "keyChordChanged",
      "textKeyChanged",
      "elementScrollChanged",
      "foregroundUnchanged",
      "noInterruption",
    ].every((name) => checks[name] === true);
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        version: 1,
        platform,
        appId,
        osVersion: release(),
        at: new Date().toISOString(),
        helperSha256: createHash("sha256")
          .update(await readFile(resolve(executable)))
          .digest("hex"),
        sourceSha256: createHash("sha256")
          .update(await readFile(import.meta.filename))
          .digest("hex"),
        passed,
        checks,
        ...(failure ? { failure } : {}),
        limitations: [
          "A debug-helper rehearsal does not certify installed-build attribution, every chord, or interruption latency. Measure cursor preservation and input latency separately.",
        ],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  if (!passed) process.exitCode = 1;
}
