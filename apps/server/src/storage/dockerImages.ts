import { runProcess, type ProcessRunResult } from "../processRunner.ts";

/**
 * Unused Docker images, through the Docker CLI. Only `docker image prune -a`
 * runs: volumes, containers and build cache are never touched.
 */

export type DockerRunner = (
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal | undefined },
) => Promise<ProcessRunResult>;

export const runDocker: DockerRunner = (args, options) =>
  runProcess("docker", args, {
    env: process.env,
    timeoutMs: options.timeoutMs,
    allowNonZeroExit: true,
    maxBufferBytes: 1024 * 1024,
    outputMode: "truncate",
    signal: options.signal,
  });

const INSPECT_TIMEOUT_MS = 10_000;
const PRUNE_TIMEOUT_MS = 10 * 60_000;
const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** Docker prints decimal sizes such as `2.627GB (92%)` or `0B`. */
export function parseDockerSize(text: string): number | null {
  const match = /^\s*([\d.]+)\s*([a-z]*)/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = UNITS[(match[2] || "b").toLowerCase()];
  if (!Number.isFinite(value) || unit === undefined) return null;
  return Math.round(value * unit);
}

export type DockerImagesInspection =
  | {
      readonly status: "ready";
      readonly totalBytes: number;
      readonly reclaimableBytes: number;
      readonly imageCount: number;
      readonly activeCount: number;
    }
  | { readonly status: "unavailable"; readonly reason: string };

function unavailableReason(result: ProcessRunResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (result.timedOut) return "Docker did not answer within 10 seconds.";
  if (
    /cannot connect to the docker daemon|is the docker daemon running|error during connect/i.test(
      output,
    )
  )
    return "Docker is not running. Start Docker and rescan.";
  return `Docker could not report disk usage: ${output.trim().split("\n")[0] || `exit ${result.code}`}`;
}

function startFailure(error: unknown): string {
  return /command not found|ENOENT/i.test(String(error))
    ? "The Docker CLI is not installed."
    : `Docker could not be started: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Null when the CLI talks to an engine on this machine (a unix socket or
 * named pipe), otherwise why images are not offered. DOCKER_HOST overrides
 * the active context, as it does for the CLI.
 */
async function remoteEngineReason(
  run: DockerRunner,
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  let host = env.DOCKER_HOST?.trim();
  if (!host) {
    let result: ProcessRunResult;
    try {
      result = await run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
        timeoutMs: INSPECT_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      return startFailure(error);
    }
    if (result.code !== 0 || result.timedOut) return unavailableReason(result);
    host = result.stdout.trim();
  }
  return /^(?:unix|npipe):\/\//i.test(host)
    ? null
    : `Docker uses an engine that is not on this machine (${host}); its images do not use this disk.`;
}

export async function inspectDockerImages(
  run: DockerRunner = runDocker,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DockerImagesInspection> {
  const remote = await remoteEngineReason(run, signal, env);
  if (remote !== null) return { status: "unavailable", reason: remote };
  let result: ProcessRunResult;
  try {
    result = await run(["system", "df", "--format", "{{json .}}"], {
      timeoutMs: INSPECT_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    signal?.throwIfAborted();
    return { status: "unavailable", reason: startFailure(error) };
  }
  if (result.code !== 0 || result.timedOut)
    return { status: "unavailable", reason: unavailableReason(result) };
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.Type !== "Images") continue;
    const totalBytes = parseDockerSize(String(row.Size ?? ""));
    const reclaimableBytes = parseDockerSize(String(row.Reclaimable ?? ""));
    if (totalBytes === null || reclaimableBytes === null) break;
    return {
      status: "ready",
      totalBytes,
      reclaimableBytes,
      imageCount: Number(row.TotalCount) || 0,
      activeCount: Number(row.Active) || 0,
    };
  }
  return { status: "unavailable", reason: "Docker reported disk usage in an unrecognized format." };
}

/** Removes every image no container uses. Returns Docker's reported reclaimed bytes. */
export async function pruneDockerImages(
  run: DockerRunner = runDocker,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  // The context may have changed since review.
  const remote = await remoteEngineReason(run, signal, env);
  if (remote !== null) throw new Error(remote);
  let result: ProcessRunResult;
  try {
    result = await run(["image", "prune", "--all", "--force"], {
      timeoutMs: PRUNE_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    throw new Error(startFailure(error), { cause: error });
  }
  if (result.code !== 0 || result.timedOut) throw new Error(unavailableReason(result));
  const reclaimed = /Total reclaimed space:\s*(\S+)/i.exec(result.stdout)?.[1];
  return reclaimed ? (parseDockerSize(reclaimed) ?? 0) : 0;
}
