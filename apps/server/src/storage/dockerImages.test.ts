import { describe, expect, it } from "vitest";
import type { ProcessRunResult } from "../processRunner.ts";
import {
  inspectDockerImages,
  parseDockerSize,
  pruneDockerImages,
  type DockerRunner,
} from "./dockerImages.ts";

const result = (patch: Partial<ProcessRunResult>): ProcessRunResult => ({
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
  ...patch,
});

const CONTEXT = ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"];
const LOCAL_ENV = {};

/** Answers the endpoint lookup with `endpoint`, and every other call with `outcome`. */
const runner =
  (
    outcome: ProcessRunResult | Error,
    calls: Array<ReadonlyArray<string>> = [],
    endpoint = "unix:///var/run/docker.sock",
  ): DockerRunner =>
  async (args) => {
    calls.push(args);
    if (outcome instanceof Error) throw outcome;
    if (args[0] === "context") return result({ stdout: `${endpoint}\n` });
    return outcome;
  };

describe("Docker unused images", () => {
  it("parses Docker's decimal sizes", () => {
    expect(parseDockerSize("2.627GB (92%)")).toBe(2_627_000_000);
    expect(parseDockerSize("398.8kB")).toBe(398_800);
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("12MiB")).toBe(12 * 1024 * 1024);
    expect(parseDockerSize("n/a")).toBeNull();
  });

  it("reads the Images row from docker system df", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const stdout = [
      '{"Active":"3","Reclaimable":"2.627GB (92%)","Size":"2.828GB","TotalCount":"7","Type":"Images"}',
      '{"Active":"0","Reclaimable":"2.859GB (100%)","Size":"2.859GB","TotalCount":"12","Type":"Local Volumes"}',
    ].join("\n");
    expect(
      await inspectDockerImages(runner(result({ stdout }), calls), undefined, LOCAL_ENV),
    ).toEqual({
      status: "ready",
      totalBytes: 2_828_000_000,
      reclaimableBytes: 2_627_000_000,
      imageCount: 7,
      activeCount: 3,
    });
    expect(calls).toEqual([CONTEXT, ["system", "df", "--format", "{{json .}}"]]);
  });

  it("refuses an engine on another machine, from the context or DOCKER_HOST", async () => {
    const stdout =
      '{"Active":"0","Reclaimable":"1GB (100%)","Size":"1GB","TotalCount":"1","Type":"Images"}';
    const calls: Array<ReadonlyArray<string>> = [];
    const remote = await inspectDockerImages(
      runner(result({ stdout }), calls, "tcp://build-host:2376"),
      undefined,
      LOCAL_ENV,
    );
    expect(remote).toMatchObject({ status: "unavailable" });
    expect(remote.status === "unavailable" && remote.reason).toContain("tcp://build-host:2376");
    expect(calls).toEqual([CONTEXT]);

    expect(
      await inspectDockerImages(runner(result({ stdout })), undefined, {
        DOCKER_HOST: "ssh://me@server",
      }),
    ).toMatchObject({ status: "unavailable" });
    // DOCKER_HOST wins over the context, as it does for the CLI.
    const local = await inspectDockerImages(
      runner(result({ stdout }), [], "tcp://build-host:2376"),
      undefined,
      { DOCKER_HOST: "unix:///Users/me/.colima/default/docker.sock" },
    );
    expect(local.status).toBe("ready");

    const pruneCalls: Array<ReadonlyArray<string>> = [];
    await expect(
      pruneDockerImages(
        runner(result({ stdout: "Total reclaimed space: 1GB" }), pruneCalls, "tcp://h:2376"),
        undefined,
        LOCAL_ENV,
      ),
    ).rejects.toThrow("not on this machine");
    expect(pruneCalls).toEqual([CONTEXT]);
  });

  it("reports a missing CLI and a stopped daemon as unavailable", async () => {
    const inspect = (run: DockerRunner) => inspectDockerImages(run, undefined, LOCAL_ENV);
    expect(await inspect(runner(new Error("Command not found: docker")))).toEqual({
      status: "unavailable",
      reason: "The Docker CLI is not installed.",
    });
    expect(
      await inspect(
        runner(
          result({
            code: 1,
            stderr:
              "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
          }),
        ),
      ),
    ).toEqual({ status: "unavailable", reason: "Docker is not running. Start Docker and rescan." });
    expect(await inspect(runner(result({ timedOut: true, code: null })))).toEqual({
      status: "unavailable",
      reason: "Docker did not answer within 10 seconds.",
    });
  });

  it("prunes only unused images and parses the reclaimed total", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const stdout = "Deleted Images:\nuntagged: alpine:3\n\nTotal reclaimed space: 1.2GB\n";
    expect(await pruneDockerImages(runner(result({ stdout }), calls), undefined, LOCAL_ENV)).toBe(
      1_200_000_000,
    );
    expect(calls).toEqual([CONTEXT, ["image", "prune", "--all", "--force"]]);
    expect(
      await pruneDockerImages(
        runner(result({ stdout: "Total reclaimed space: 0B" })),
        undefined,
        LOCAL_ENV,
      ),
    ).toBe(0);
  });

  it("fails the prune when Docker is unavailable", async () => {
    const prune = (run: DockerRunner) => pruneDockerImages(run, undefined, LOCAL_ENV);
    await expect(
      prune(runner(result({ code: 1, stderr: "error during connect: dial unix" }))),
    ).rejects.toThrow("Docker is not running");
    await expect(prune(runner(new Error("Command not found: docker")))).rejects.toThrow(
      "The Docker CLI is not installed.",
    );
  });
});
