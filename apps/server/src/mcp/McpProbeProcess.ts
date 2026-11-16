import type { ChildProcess } from "node:child_process";
import { killProcessTreeAsync } from "@t3tools/shared/processTree";

/** Keep a live group for descendants, but never escalate a known exited Windows PID. */
export async function closeProbeProcess(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill" | "once" | "removeListener">,
  environment: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    graceMs?: number;
    killTree?: typeof killProcessTreeAsync;
    groupExists?: (pid: number) => boolean;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const killTree = options.killTree ?? killProcessTreeAsync;
  const groupExists =
    options.groupExists ??
    ((pid: number) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    });
  let exited = child.exitCode !== null || child.signalCode !== null;
  const onExit = () => {
    exited = true;
  };
  child.once("exit", onExit);
  const alive = () =>
    child.pid !== undefined && (platform === "win32" ? !exited : groupExists(child.pid));
  try {
    if (!alive()) return;
    await killTree(child, {
      isGroupLeader: platform !== "win32",
      graceful: true,
      environment,
      platform,
    });
    const deadline = Date.now() + (options.graceMs ?? 2000);
    while (alive() && Date.now() < deadline)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))),
      );
    if (alive())
      await killTree(child, {
        isGroupLeader: platform !== "win32",
        graceful: false,
        environment,
        platform,
      });
  } finally {
    child.removeListener("exit", onExit);
  }
}
