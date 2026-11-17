// @effect-diagnostics nodeBuiltinImport:off
// Task Scheduler and the stable launcher run outside the server's Effect runtime.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicJson, exists, readJson } from "./files";

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export function quoteWindowsServiceArgument(value: string): string {
  if (/[\r\n]/.test(value) || value.includes("\0")) throw new Error("Invalid service argument.");
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
}
export interface WindowsServiceIdentity {
  readonly userId: string;
  readonly systemRoot: string;
}
export function windowsServiceTask(command: readonly string[], identity: WindowsServiceIdentity) {
  if (command.length < 4 || !identity.userId || !path.win32.isAbsolute(identity.systemRoot))
    throw new Error("Windows services require a user identity, SystemRoot and launcher paths.");
  const root = command[2]!;
  const hash = createHash("sha256").update(root).digest("hex");
  const taskName =
    "f5-" +
    createHash("sha256")
      .update(identity.userId + "\0" + root)
      .digest("hex")
      .slice(0, 24);
  const arguments_ = [...command, "--service"].map(quoteWindowsServiceArgument).join(" ");
  const contents = [
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "<RegistrationInfo><Description>F5-managed:" + hash + "</Description></RegistrationInfo>",
    "<Triggers><LogonTrigger><UserId>" + xml(identity.userId) + "</UserId></LogonTrigger>",
    "<TimeTrigger><StartBoundary>2000-01-01T00:00:00</StartBoundary><Repetition><Interval>PT1M</Interval></Repetition></TimeTrigger></Triggers>",
    '<Principals><Principal id="Author"><UserId>' +
      xml(identity.userId) +
      "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>5</Priority></Settings>",
    '<Actions Context="Author"><Exec><Command>' +
      xml(path.win32.join(identity.systemRoot, "System32", "conhost.exe")) +
      "</Command><Arguments>--headless " +
      xml(arguments_) +
      "</Arguments><WorkingDirectory>" +
      xml(path.win32.dirname(command[0]!)) +
      "</WorkingDirectory></Exec></Actions>",
    "</Task>\n",
  ].join("\n");
  return { name: taskName + ".xml", taskName, contents, ownership: "F5-managed:" + hash };
}

const execute = promisify(execFile);
export interface WindowsServiceHost extends WindowsServiceIdentity {
  readonly execute: (args: string[]) => Promise<{ stdout: string }>;
}
export async function manageWindowsService(
  action: string,
  root: string,
  stateDir: string,
  host: WindowsServiceHost = {
    userId: [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join("\\"),
    systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
    execute: (args) =>
      execute("schtasks.exe", args, { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true }),
  },
): Promise<void> {
  const task = windowsServiceTask(
    [
      path.join(root, "launcher-v1", "node.exe"),
      path.join(root, "launcher-v1", "launcher.cjs"),
      root,
      stateDir,
    ],
    host,
  );
  const file = path.join(stateDir, task.name);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = await fs
    .open(path.join(stateDir, ".service-manager-lock"), "wx", 0o600)
    .catch(() => {
      throw new Error("Another service command is running; refusing concurrent changes.");
    });
  const target = ["/TN", task.taskName];
  const run = () => host.execute(["/Run", ...target]);
  const stop = async () => {
    // A repeating trigger must not restart a service while it is stopped or being uninstalled.
    await host.execute(["/Change", ...target, "/DISABLE"]);
    const leasePath = path.join(root, "launcher.json");
    if (!(await exists(leasePath))) return;
    const lease = (await readJson(leasePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    })) as { token?: unknown; service?: unknown } | null;
    if (lease === null) return;
    if (typeof lease?.token !== "string" || lease.service !== true)
      throw new Error("The active launcher is not this Windows service; refusing to stop it.");
    await atomicJson(path.join(root, "service-stop.json"), { token: lease.token });
    const deadline = Date.now() + 120_000;
    while (await exists(leasePath)) {
      const current = (await readJson(leasePath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      })) as { token?: unknown } | null;
      if (current === null) break;
      if (current.token !== lease.token)
        throw new Error("The launcher changed while stopping; refusing another lifecycle action.");
      if (Date.now() >= deadline)
        throw new Error("The service has not finished stopping; it remains disabled.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  try {
    if (action === "install") {
      await fs.mkdir(path.join(stateDir, "logs"), { recursive: true, mode: 0o700 });
      const definition = await fs.open(file, "wx", 0o600);
      try {
        await definition.writeFile(task.contents, "utf8");
      } finally {
        await definition.close();
      }
      // No /F: an existing task, including an unrelated task, is never overwritten.
      await host.execute(["/Create", "/XML", file, ...target]);
      await run();
      return;
    }
    if (!(await fs.readFile(file, "utf8")).includes(task.ownership))
      throw new Error("The service definition belongs to another installation.");
    const registered = await host.execute(["/Query", ...target, "/XML"]);
    if (!registered.stdout.includes(task.ownership))
      throw new Error("The scheduled task belongs to another installation.");
    if (action === "status") {
      console.log(registered.stdout);
      return;
    }
    if (action === "stop" || action === "restart" || action === "uninstall") await stop();
    if (action === "uninstall") {
      await host.execute(["/Delete", ...target, "/F"]);
      await fs.unlink(file);
    } else if (action === "start" || action === "restart") {
      await host.execute(["/Change", ...target, "/ENABLE"]);
      await run();
    } else if (action !== "stop") throw new Error("Unknown service action.");
  } finally {
    await lock.close();
    await fs.unlink(path.join(stateDir, ".service-manager-lock"));
  }
}
