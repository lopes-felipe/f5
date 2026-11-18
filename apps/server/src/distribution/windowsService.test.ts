import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { atomicJson } from "./files";
import { acquireInstanceLock } from "../profiles/InstanceLock";
import {
  manageWindowsService,
  quoteWindowsServiceArgument,
  windowsServiceTask,
  type WindowsServiceHost,
} from "./windowsService";

const identity = { userId: "DOMAIN\\user&name", systemRoot: "C:\\Windows" };
let root: string;
let state: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-windows-service-"));
  state = path.join(root, "state");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function fixture() {
  const calls: string[][] = [];
  let registered = false;
  const task = windowsServiceTask(
    [
      path.join(root, "launcher-v1", "node.exe"),
      path.join(root, "launcher-v1", "launcher.cjs"),
      root,
      state,
    ],
    identity,
  );
  const host: WindowsServiceHost = {
    ...identity,
    probeProcess: async (pid) => pid === process.pid,
    isTaskRunning: async () => false,
    execute: async (args) => {
      calls.push(args);
      if (args[0] === "/Query" && !registered) throw new Error("Task not found");
      if (args[0] === "/Create") registered = true;
      if (args[0] === "/Delete") registered = false;
      return { stdout: args[0] === "/Query" ? task.contents : "" };
    },
  };
  return { calls, task, host };
}
describe("Windows service task", () => {
  it("uses an interactive least-privilege hidden console with restart and no execution limit", () => {
    const task = windowsServiceTask(
      ["C:\\F5 space\\node.exe", "C:\\F5 space\\launcher.cjs", "C:\\F5", "C:\\Profile"],
      identity,
    );
    expect(task.contents).toContain("DOMAIN\\user&amp;name");
    expect(task.contents).toContain("InteractiveToken");
    expect(task.contents).toContain("LeastPrivilege");
    expect(task.contents).toContain("<Arguments>--headless &quot;C:\\F5 space\\node.exe&quot;");
    expect(task.contents).toContain("&quot;--service&quot;");
    expect(task.contents).toContain("<Interval>PT1M</Interval>");
    expect(task.contents).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(task.contents).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(quoteWindowsServiceArgument("C:\\dir\\")).toBe('"C:\\dir\\\\"');
    expect(() => quoteWindowsServiceArgument("bad\npath")).toThrow();
  });
  it("registers without replacing existing tasks, and enables/disables around start and stop", async () => {
    const { calls, host } = fixture();
    await manageWindowsService("install", root, state, host);
    expect(calls[1]?.[0]).toBe("/Create");
    expect(calls[1]).not.toContain("/F");
    await manageWindowsService("stop", root, state, host);
    expect(calls.at(-1)).toContain("/DISABLE");
    await manageWindowsService("start", root, state, host);
    expect(calls.at(-2)).toContain("/ENABLE");
    expect(calls.at(-1)?.[0]).toBe("/Run");
  });
  it("does not change a registered task whose ownership differs from the saved definition", async () => {
    const { calls, host } = fixture();
    await manageWindowsService("install", root, state, host);
    calls.length = 0;
    await expect(
      manageWindowsService("stop", root, state, {
        ...host,
        execute: async (args) => {
          calls.push(args);
          return { stdout: "<Description>Unrelated</Description>" };
        },
      }),
    ).rejects.toThrow("another installation");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("/Query");
  });
  it("waits for graceful launcher shutdown before restart and rejects a foreground launcher", async () => {
    const { calls, task, host } = fixture();
    await manageWindowsService("install", root, state, host);
    await atomicJson(path.join(root, "launcher.json"), {
      token: "current",
      service: true,
      pid: process.pid,
    });
    const launcherPath = path.join(root, "launcher.json");
    // Observe rejection immediately, and join shutdown even if polling fails.
    // Otherwise a retried test can remove the directory under the pending write.
    const restarting = manageWindowsService("restart", root, state, host).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await expect
        .poll(
          async () =>
            JSON.parse(await fs.readFile(path.join(root, "service-stop.json"), "utf8")).token,
          { timeout: 10_000 },
        )
        .toBe("current");
      expect(calls.at(-1)).toContain("/DISABLE");
      await fs.unlink(launcherPath);
      const outcome = await restarting;
      if (!outcome.ok) throw outcome.error;
      expect(calls.at(-2)).toContain("/ENABLE");
      expect(calls.at(-1)).toEqual(["/Run", "/TN", task.taskName]);
    } finally {
      await fs.rm(launcherPath, { force: true });
      await restarting;
    }
    await atomicJson(path.join(root, "launcher.json"), { token: "foreground" });
    await expect(manageWindowsService("stop", root, state, host)).rejects.toThrow(
      "not this Windows service",
    );
  });
  it("ignores legacy leftover locks but excludes a live command", async () => {
    const { host } = fixture();
    await fs.mkdir(state);
    await fs.writeFile(path.join(state, ".service-manager-lock"), "");
    await manageWindowsService("install", root, state, host);
    const lock = await acquireInstanceLock(path.join(root, ".service-manager-lock.sqlite"));
    try {
      await expect(manageWindowsService("start", root, state, host)).rejects.toThrow(
        "Another service command",
      );
    } finally {
      lock.release();
    }
    await manageWindowsService("start", root, state, host);
  });
  it("serializes one task across different state directories", async () => {
    const { host } = fixture();
    const lock = await acquireInstanceLock(path.join(root, ".service-manager-lock.sqlite"));
    try {
      await expect(
        manageWindowsService("install", root, path.join(root, "other-state"), host),
      ).rejects.toThrow("Another service command");
    } finally {
      lock.release();
    }
  });
  it("never uninstalls a starting task whose lease has not appeared", async () => {
    const { host, calls } = fixture();
    await manageWindowsService("install", root, state, host);
    await expect(
      manageWindowsService("uninstall", root, state, {
        ...host,
        stopTimeoutMs: 0,
        isTaskRunning: async () => true,
      }),
    ).rejects.toThrow("still starting");
    expect(calls.some((args) => args[0] === "/Delete")).toBe(false);
  });
  it("treats a dead launcher and dead child as already stopped", async () => {
    const { calls, host } = fixture();
    await manageWindowsService("install", root, state, host);
    await atomicJson(path.join(root, "launcher.json"), {
      token: "dead",
      service: true,
      pid: 999999999,
      child: null,
    });
    await manageWindowsService("uninstall", root, state, host);
    expect(calls.at(-1)?.[0]).toBe("/Delete");
  });
  it("retries registration after a failed Create without overwriting another task", async () => {
    const { host, calls } = fixture();
    let fail = true;
    const flaky = {
      ...host,
      execute: async (args: string[]) => {
        if (args[0] === "/Create" && fail) {
          fail = false;
          throw new Error("Registration failed");
        }
        return host.execute(args);
      },
    };
    await expect(manageWindowsService("install", root, state, flaky)).rejects.toThrow(
      "Registration failed",
    );
    await manageWindowsService("install", root, state, flaky);
    expect(calls.some((args) => args[0] === "/Create")).toBe(true);
    expect(calls.flat()).not.toContain("/F");
  });
  it("keeps a timed out stop disabled and releases the command lock", async () => {
    const { calls, host } = fixture();
    await manageWindowsService("install", root, state, host);
    await atomicJson(path.join(root, "launcher.json"), {
      token: "live",
      service: true,
      pid: process.pid,
    });
    await expect(
      manageWindowsService("stop", root, state, { ...host, stopTimeoutMs: 0 }),
    ).rejects.toThrow("remains disabled");
    expect(calls.at(-1)).toContain("/DISABLE");
    await manageWindowsService("start", root, state, host);
    expect(calls.at(-1)?.[0]).toBe("/Run");
  });
});
