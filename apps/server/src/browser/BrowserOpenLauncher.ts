import { javascriptRuntimeExecutable } from "@t3tools/shared/hostRuntime";
import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

export const browserLauncherDir = (stateDir: string) => Path.join(stateDir, "browser-bin");
export const browserLauncherPath = (stateDir: string) =>
  Path.join(browserLauncherDir(stateDir), "f5-open-url");

export function browserOpenSocketPath(stateDir: string): string {
  const local = Path.join(stateDir, "browser-open", "open.sock");
  return Buffer.byteLength(local) <= 100
    ? local
    : Path.join(
        OS.tmpdir(),
        "f5-browser-" + createHash("sha256").update(stateDir).digest("hex").slice(0, 12) + ".sock",
      );
}

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** Contains only paths: login URLs and credentials are never persisted. */
export async function prepareBrowserOpenLauncher(
  stateDir: string,
  socketPath = browserOpenSocketPath(stateDir),
): Promise<void> {
  const directory = browserLauncherDir(stateDir);
  await FS.mkdir(directory, { recursive: true, mode: 0o700 });
  await FS.chmod(directory, 0o700);
  const script = Path.join(directory, "open-url.cjs");
  const files = [
    [
      script,
      String.raw`const net = require("node:net");
const args = process.argv.slice(2);
if (args.length === 1) process.stderr.write("Open this URL to continue: " + args[0] + "\n");
let url;
try { url = new URL(args[0]); } catch { process.exit(1); }
if (args.length !== 1 || !["http:", "https:"].includes(url.protocol)) process.exit(1);
const socket = net.createConnection(${JSON.stringify(socketPath)});
const exit = (code) => { socket.destroy(); process.exit(code); };
const timer = setTimeout(() => exit(2), 6 * 60 * 1000);
let reply = "";
socket.on("connect", () => socket.write(JSON.stringify({ url: args[0] }) + "\n"));
socket.on("data", (chunk) => {
  reply += chunk.toString("utf8");
  if (Buffer.byteLength(reply) > 8192) return exit(2);
  if (!reply.includes("\n")) return;
  try {
    const { status } = JSON.parse(reply.slice(0, reply.indexOf("\n")));
    exit(status === "opened" || status === "copied" ? 0 :
      ["denied", "busy", "invalid"].includes(status) ? 1 : 2);
  } catch { exit(2); }
});
socket.on("error", () => exit(2));
socket.on("close", () => { clearTimeout(timer); exit(2); });
`,
    ],
    [
      browserLauncherPath(stateDir),
      `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec ${quote(javascriptRuntimeExecutable())} ${quote(script)} "$@"
`,
    ],
    [
      Path.join(directory, "open"),
      `#!/bin/sh
if [ "$#" -eq 1 ]; then
  case "$1" in
    [hH][tT][tT][pP]://*|[hH][tT][tT][pP][sS]://*) exec ${quote(browserLauncherPath(stateDir))} "$@" ;;
  esac
fi
exec /usr/bin/open "$@"
`,
    ],
  ] as const;
  for (const [file, source] of files) {
    await FS.writeFile(file, source, { mode: 0o700 });
    await FS.chmod(file, 0o700);
  }
}
