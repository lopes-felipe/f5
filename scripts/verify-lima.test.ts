import { createRequire } from "node:module";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type Run = (command: string, args: string[]) => { status: number | null; output: string };
const { verifyLima } = require("./verify-computer-helper.cjs") as {
  verifyLima(app: string, run: Run): void;
};

let app: string;
beforeEach(() => {
  app = FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-verify-lima-"));
  for (const file of [
    "bin/limactl",
    "share/lima/lima-guestagent.Linux-aarch64.gz",
    "share/lima/templates/default.yaml",
  ]) {
    const path = Path.join(app, "Contents/Resources/native/lima", file);
    FS.mkdirSync(Path.dirname(path), { recursive: true });
    FS.writeFileSync(path, "");
  }
});
afterEach(() => {
  FS.rmSync(app, { recursive: true, force: true });
});

/** codesign output shaped like the real tool's, for a binary signed as described. */
function codesign(options: { runtime?: boolean; virtualization?: boolean; valid?: boolean }): Run {
  return (_command, args) => {
    if (args[0] === "--verify") return { status: options.valid === false ? 1 : 0, output: "" };
    if (args[0] === "-dv")
      return {
        status: 0,
        output: `CodeDirectory v=20500 size=1 flags=${options.runtime ? "0x10000(runtime)" : "0x0(none)"} hashes=1+7\n`,
      };
    return {
      status: 0,
      // Pretty-printed, as a plist may be: whitespace between the key and its value.
      output: `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n${options.virtualization ? "\t<key>com.apple.security.virtualization</key>\n\t<true/>\n" : ""}</dict>\n</plist>\n`,
    };
  };
}

it("accepts limactl signed with hardened runtime and the virtualization entitlement", () => {
  expect(() => verifyLima(app, codesign({ runtime: true, virtualization: true }))).not.toThrow();
});

it("refuses an invalid signature, no hardened runtime or no virtualization entitlement", () => {
  expect(() =>
    verifyLima(app, codesign({ runtime: true, virtualization: true, valid: false })),
  ).toThrow(/signing verification failed/);
  expect(() => verifyLima(app, codesign({ virtualization: true }))).toThrow(/hardened runtime/);
  expect(() => verifyLima(app, codesign({ runtime: true }))).toThrow(/virtualization/);
});

it("refuses an app missing a Lima file", () => {
  FS.rmSync(Path.join(app, "Contents/Resources/native/lima/share/lima/templates/default.yaml"));
  expect(() => verifyLima(app, codesign({ runtime: true, virtualization: true }))).toThrow(
    /Packaged Lima file missing/,
  );
});
