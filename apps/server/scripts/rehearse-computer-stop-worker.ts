import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerAutomationBrokerRuntime } from "../src/computer/ComputerAutomationBroker";
import { DesktopComputerHost } from "../src/computer/DesktopComputerHost";

// A real broker/host IPC backend, with no provider, credentials or shell tools.
// The parent stops only this process with SIGSTOP after native input begins.
const root = process.env.F5_REHEARSAL_ROOT;
const appId = process.env.F5_REHEARSAL_APP_ID;
const profileId = process.env.F5_REHEARSAL_PROFILE_ID;
const threadId = process.env.F5_REHEARSAL_THREAD_ID;
const generation = process.env.F5_REHEARSAL_GENERATION;
if (
  process.platform !== "darwin" ||
  process.env.F5_COMPUTER_STOP_REHEARSAL !== "1" ||
  process.env.F5_DESKTOP_COMPUTER_HOST !== "ipc" ||
  !process.send ||
  !root ||
  !profileId ||
  !threadId ||
  !generation ||
  !appId?.startsWith("org.example.computer-rehearsal.")
)
  throw new Error("Start through the coordinated native stop rehearsal.");
const host = DesktopComputerHost.fromEnvironment(profileId);
const broker = new ComputerAutomationBrokerRuntime(host, {
  platform: "darwin",
  resolve: async (thread, sessionGeneration) => ({
    threadId: thread,
    sessionGeneration,
    provider: "codex",
    projectId: "synthetic-stop-fixture",
    turnId: "stop-rehearsal",
    threadTitle: "Frozen backend stop rehearsal",
    runtimeMode: "approval-required",
    interactionMode: "default",
    policy: {
      computerUse: true,
      claudeInChrome: false,
      codexChrome: false,
      previewAutomation: false,
      externalHosts: [],
    },
  }),
  storage: { load: async () => [], save: async () => {} },
});
let begin = () => {};
const beginTyping = new Promise<void>((done) => {
  begin = done;
});
process.once("SIGUSR2", () => begin());
process.once("SIGTERM", () => {
  broker.setPaused(threadId, true);
  begin();
});
let mutationInterrupted = false;
try {
  await broker.initialize();
  broker.bindSession(threadId, generation, "codex");
  const deadline = Date.now() + 5000;
  while (!host.status().available) {
    if (Date.now() > deadline) throw new Error("Desktop host unavailable.");
    await new Promise<void>((done) => setTimeout(done, 10));
  }
  await broker.requestAccess(threadId, generation, [appId], "Synthetic frozen-backend stop test");
  await broker.invoke(threadId, generation, { op: "activateApp", appId, screenshot: false });
  process.stdout.write("STOP_WORKER_READY\n");
  await beginTyping;
  await broker.invoke(threadId, generation, {
    op: "type",
    text: "x".repeat(10000),
    screenshot: false,
  });
} catch (error) {
  mutationInterrupted = error instanceof ComputerControlError && error.error._tag === "Interrupted";
  if (!mutationInterrupted) process.exitCode = 1;
} finally {
  broker.endTurn(threadId, "stop-rehearsal", generation);
  broker.close();
  await writeFile(join(root, "stop-worker-result.json"), JSON.stringify({ mutationInterrupted }));
  process.disconnect?.();
}
