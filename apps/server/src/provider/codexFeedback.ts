import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CodexControlClient,
  type CodexControlEnvironmentConfig,
} from "../codex/CodexControlClient";
import { supportsCodexRelease5 } from "@t3tools/shared/providerRuntimeCapabilities";

export const CODEX_FEEDBACK_TIMEOUT_MS = 120_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETAIN_COUNT = 10;

export async function pruneCodexFeedback(
  directory: string,
  prefix: string,
  current: string,
  now = Date.now(),
): Promise<void> {
  const files = await Promise.all(
    (await fs.readdir(directory))
      .filter((name) => name.startsWith(prefix) && name.endsWith(".zip"))
      .map(async (name) => {
        const file = path.join(directory, name);
        const stat = await fs.lstat(file);
        return { file, stat };
      }),
  );
  const older = files
    .filter(({ file, stat }) => stat.isFile() && file !== current)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  await Promise.all(
    older
      .filter(({ stat }, index) => index >= RETAIN_COUNT - 1 || now - stat.mtimeMs > RETENTION_MS)
      .map(({ file }) => fs.rm(file, { force: true })),
  );
}

/** A dedicated mutation: no inventory reads and no transport busy-retry. */
export async function saveCodexFeedback(
  environment: CodexControlEnvironmentConfig,
  stateDir: string,
  instanceId: string,
  timeoutMs = CODEX_FEEDBACK_TIMEOUT_MS,
): Promise<{ path: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let client: CodexControlClient | undefined;
  let savedPath: string | undefined;
  let success = false;
  let abort: (() => void) | undefined;
  const directory = path.join(stateDir, "diagnostics");
  const prefix =
    "codex-feedback-" + createHash("sha256").update(instanceId).digest("hex").slice(0, 16) + "-";
  try {
    client = await CodexControlClient.create(environment, signal);
    if (!supportsCodexRelease5(client.cliVersion))
      throw new Error("Feedback bundles require Codex 0.166.0 or later.");
    await fs.mkdir(directory, { recursive: true });
    savedPath = path.join(
      directory,
      prefix + new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID() + ".zip",
    );
    const expired = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Codex feedback save timed out."));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    await Promise.race([client.saveFeedback(savedPath, timeoutMs), expired]);
    success = true;
    await pruneCodexFeedback(directory, prefix, savedPath).catch(() => undefined);
    return { path: savedPath };
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    await client?.closeAndWait();
    if (!success && savedPath) await fs.rm(savedPath, { force: true }).catch(() => undefined);
  }
}
