import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { atomicJson } from "./files";
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
    execute: async (args) => {
      calls.push(args);
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
    expect(calls[0]?.[0]).toBe("/Create");
    expect(calls[0]).not.toContain("/F");
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
    await atomicJson(path.join(root, "launcher.json"), { token: "current", service: true });
    const restarting = manageWindowsService("restart", root, state, host);
    await expect
      .poll(
        async () =>
          JSON.parse(await fs.readFile(path.join(root, "service-stop.json"), "utf8")).token,
      )
      .toBe("current");
    expect(calls.at(-1)).toContain("/DISABLE");
    await fs.unlink(path.join(root, "launcher.json"));
    await restarting;
    expect(calls.at(-2)).toContain("/ENABLE");
    expect(calls.at(-1)).toEqual(["/Run", "/TN", task.taskName]);
    await atomicJson(path.join(root, "launcher.json"), { token: "foreground" });
    await expect(manageWindowsService("stop", root, state, host)).rejects.toThrow(
      "not this Windows service",
    );
  });
});
