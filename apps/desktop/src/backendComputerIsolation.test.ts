import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isolatedBackendCommand, MAC_BACKEND_COMPUTER_SANDBOX } from "./backendComputerIsolation";
describe("backend GUI permission isolation", () => {
  it("applies the macOS sandbox independently of the computer setting", () => {
    expect(isolatedBackendCommand("darwin", "/F5", "/backend")).toEqual({
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", MAC_BACKEND_COMPUTER_SANDBOX, "/F5", "/backend"],
    });
    expect(isolatedBackendCommand("win32", "F5.exe", "backend")).toEqual({
      executable: "F5.exe",
      args: ["backend"],
    });
  });
  it("keeps preload arguments inside the isolated backend process", () => {
    expect(
      isolatedBackendCommand("darwin", "/F5", "/backend", ["--require", "/cache.js"]).args,
    ).toEqual(["-p", MAC_BACKEND_COMPUTER_SANDBOX, "/F5", "--require", "/cache.js", "/backend"]);
  });
  it.skipIf(process.platform !== "darwin")(
    "uses a valid kernel profile and blocks Apple Events without prompting",
    () => {
      expect(
        execFileSync(
          "/usr/bin/sandbox-exec",
          ["-p", MAC_BACKEND_COMPUTER_SANDBOX, "/bin/echo", "valid"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("valid");
      // A read-only AppleEvent, no keystrokes/capture and no TCC permission request.
      expect(() =>
        execFileSync(
          "/usr/bin/sandbox-exec",
          [
            "-p",
            MAC_BACKEND_COMPUTER_SANDBOX,
            "/usr/bin/osascript",
            "-e",
            'tell application "System Events" to get name of every process',
          ],
          { timeout: 5000, stdio: "pipe" },
        ),
      ).toThrow();
    },
  );
});

it.skipIf(process.platform !== "darwin")(
  "the kernel refuses protected GUI service ports in the inherited subtree",
  () => {
    const root = mkdtempSync(join(tmpdir(), "f5-backend-isolation-"));
    try {
      const probe = fileURLToPath(
        new URL("../fixtures/backend-isolation-probe.c", import.meta.url),
      );
      const executable = join(root, "probe");
      execFileSync("/usr/bin/clang", [probe, "-o", executable], { timeout: 15_000, stdio: "pipe" });
      const result = execFileSync(
        "/usr/bin/sandbox-exec",
        ["-p", MAC_BACKEND_COMPUTER_SANDBOX, executable],
        { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(result.trim()).toBe("protectedServiceLookupsDenied=true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  25_000,
);
