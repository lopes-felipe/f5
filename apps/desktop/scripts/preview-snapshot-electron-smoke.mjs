import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPreviewSnapshotFixture } from "./preview-snapshot-fixture.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../..", import.meta.url));
const executable =
  process.argv.find((argument) => argument.startsWith("--executable="))?.slice(13) ??
  require("electron");
const version = require("electron/package.json").version;
const execFile = promisify(execFileCallback);
const env = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "DISPLAY",
    "XAUTHORITY",
    "LANG",
    "LC_ALL",
    "__CF_USER_TEXT_ENCODING",
    "__CFBundleIdentifier",
    "XPC_FLAGS",
    "XPC_SERVICE_NAME",
    "SECURITYSESSIONID",
  ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
);
const actual = await execFile(executable, ["-p", "process.versions.electron"], {
  env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  timeout: 10_000,
});
if (actual.stdout.trim() !== version)
  throw new Error(`Expected Electron ${version}; received ${actual.stdout.trim()}`);
const directory = mkdtempSync(path.join(tmpdir(), "f5-snapshot-electron-"));
const fixture = await createPreviewSnapshotFixture();
try {
  const modulePath = path.join(directory, "snapshot.cjs");
  execFileSync(
    "bun",
    [
      "build",
      path.join(root, "apps/desktop/src/preview/snapshotScript.ts"),
      "--target=node",
      "--format=cjs",
      "--outfile",
      modulePath,
    ],
    { stdio: "pipe" },
  );
  const result = await execFile(
    executable,
    [
      fileURLToPath(new URL("./preview-snapshot-electron-main.cjs", import.meta.url)),
      modulePath,
      path.join(directory, "electron-profile"),
      fixture.url,
      fixture.foreignUrl,
      fileURLToPath(new URL("./preview-snapshot-fixture.mjs", import.meta.url)),
    ],
    { env, timeout: 45_000, maxBuffer: 256 * 1024 },
  );
  console.log(result.stdout.trim());
} finally {
  await fixture.close();
  rmSync(directory, { recursive: true, force: true });
}
