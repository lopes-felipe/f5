import { resolveExecutable } from "../spawn/resolveCommand.ts";

export function resolvePtyShell(input: {
  readonly shell: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): string | null {
  return resolveExecutable(input.shell, input.env, { cwd: input.cwd });
}

export function isPtyShellNotFoundError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  if ("code" in cause && cause.code === "ENOENT") return true;

  // node-pty's Windows ConPTY binding reports a Napi::Error without a code.
  // The resolver above handles the normal missing-file case; this recognizes
  // the native backend's documented race/error shape after preflight.
  const message = "message" in cause && typeof cause.message === "string" ? cause.message : "";
  return /\bfile not found\b|\bno such file\b|\bposix_spawnp\b/iu.test(message);
}
