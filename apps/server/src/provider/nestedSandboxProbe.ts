/**
 * Whether a provider's OS sandbox can start from this server process.
 *
 * Codex and Antigravity sandbox shell commands with Seatbelt (`sandbox-exec`) on macOS. F5's
 * desktop app starts its backend inside a Seatbelt sandbox of its own (apps/desktop's
 * `MAC_BACKEND_COMPUTER_SANDBOX`), and macOS refuses to apply a second sandbox inside one:
 * `sandbox-exec: sandbox_apply: Operation not permitted`, exit 71. Every sandboxed command then
 * fails, so read-only stages fall back to F5's command policy (`resolveReadOnlyEnforcement`).
 *
 * Only macOS is checked. Linux sandboxes (user namespaces, Landlock) and Windows' AppContainer
 * have their own rules, and F5 doesn't wrap its backend in them.
 */
import { spawnSync } from "node:child_process";

type RunSync = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly timeout: number; readonly stdio: "ignore" },
) => { readonly status: number | null; readonly error?: Error | undefined };

export function probeNestedSandbox(
  platform: NodeJS.Platform = process.platform,
  run: RunSync = (command, args, options) => spawnSync(command, [...args], options),
): boolean {
  if (platform !== "darwin") return true;
  // The most permissive profile there is: it can only fail because a sandbox can't be applied.
  const result = run(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(allow default)", "/usr/bin/true"],
    {
      timeout: 5_000,
      stdio: "ignore",
    },
  );
  return result.error === undefined && result.status === 0;
}

let cached: boolean | undefined;

/** `probeNestedSandbox` for this process, run once: the answer can't change while it lives. */
export function nestedSandboxAvailable(): boolean {
  cached ??= probeNestedSandbox();
  return cached;
}
