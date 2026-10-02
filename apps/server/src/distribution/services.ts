import { createHash } from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const systemdQuote = (text: string) => {
  if (/[\r\n\0]/.test(text)) throw new Error("Service paths contain invalid characters.");
  return (
    '"' +
    text
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", () => "$$") +
    '"'
  );
};
export function serviceDefinition(
  platform: string,
  command: readonly string[],
): { name: string; contents: string } {
  if (command.some((item) => /[\r\n\0]/.test(item))) throw new Error("Invalid service arguments.");
  if (platform === "linux")
    return {
      name: "f5.service",
      contents: `[Unit]\nDescription=F5 code agent server\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${command.map(systemdQuote).join(" ")}\nRestart=on-failure\nRestartSec=5\nKillMode=mixed\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`,
    };
  if (platform === "darwin")
    return {
      name: "com.f5.server.plist",
      contents: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.f5.server</string><key>ProgramArguments</key><array>${command.map((item) => `<string>${xml(item)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer></dict></plist>\n`,
    };
  throw new Error(
    "Windows supports f5 serve in the foreground and the F5 desktop app. Service installation is available on Linux and macOS.",
  );
}
export async function manageService(action: string, root: string, stateDir: string): Promise<void> {
  const definition = serviceDefinition(process.platform, [
    path.join(root, "launcher-v1", process.platform === "win32" ? "node.exe" : "node"),
    path.join(root, "launcher-v1", "launcher.cjs"),
    root,
    stateDir,
  ]);
  const directory =
    process.platform === "linux"
      ? path.join(os.homedir(), ".config", "systemd", "user")
      : path.join(os.homedir(), "Library", "LaunchAgents");
  const file = path.join(directory, definition.name);
  const ownership = `F5-managed:${createHash("sha256").update(root).digest("hex")}`;
  const marker = process.platform === "linux" ? `# ${ownership}\n` : `<!-- ${ownership} -->\n`;
  if (action !== "install" && !(await fs.readFile(file, "utf8")).includes(marker.trim()))
    throw new Error("This service belongs to a different installation; refusing to modify it.");
  const execute = (command: string, args: string[]) =>
    exec(command, args, { timeout: 30_000, maxBuffer: 1024 * 1024 }).then((result) => {
      if (result.stdout.trim()) console.log(result.stdout.trim());
    });
  const domain = `gui/${process.getuid?.() ?? ""}`;
  if (action === "install") {
    // Never replace an unrelated service definition silently.
    await fs.mkdir(directory, { recursive: true });
    const handle = await fs.open(file, "wx", 0o600).catch(() => {
      throw new Error(
        `Service already exists at ${file}. Use f5 service start/status, or uninstall it first.`,
      );
    });
    try {
      await handle.writeFile(definition.contents + marker);
    } finally {
      await handle.close();
    }
    if (process.platform === "linux") {
      await execute("systemctl", ["--user", "daemon-reload"]);
      await execute("systemctl", ["--user", "enable", "--now", "f5.service"]);
    } else await execute("launchctl", ["bootstrap", domain, file]);
  } else if (process.platform === "linux") {
    if (action === "uninstall") {
      await execute("systemctl", ["--user", "disable", "--now", "f5.service"]);
      await fs.unlink(file);
      await execute("systemctl", ["--user", "daemon-reload"]);
    } else await execute("systemctl", ["--user", action, "f5.service"]);
  } else {
    if (action === "uninstall") {
      await execute("launchctl", ["bootout", domain, file]);
      await fs.unlink(file);
    } else if (action === "stop") await execute("launchctl", ["bootout", domain, file]);
    else if (action === "start") await execute("launchctl", ["bootstrap", domain, file]);
    else if (action === "restart")
      await execute("launchctl", ["kickstart", "-k", `${domain}/com.f5.server`]);
    else await execute("launchctl", ["print", `${domain}/com.f5.server`]);
  }
}
