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

const runner =
  (outcome: ProcessRunResult | Error, calls: Array<ReadonlyArray<string>> = []): DockerRunner =>
  async (args) => {
    calls.push(args);
    if (outcome instanceof Error) throw outcome;
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
    expect(await inspectDockerImages(runner(result({ stdout }), calls))).toEqual({
      status: "ready",
      totalBytes: 2_828_000_000,
      reclaimableBytes: 2_627_000_000,
      imageCount: 7,
      activeCount: 3,
    });
    expect(calls).toEqual([["system", "df", "--format", "{{json .}}"]]);
  });

  it("reports a missing CLI and a stopped daemon as unavailable", async () => {
    expect(await inspectDockerImages(runner(new Error("Command not found: docker")))).toEqual({
      status: "unavailable",
      reason: "The Docker CLI is not installed.",
    });
    expect(
      await inspectDockerImages(
        runner(
          result({
            code: 1,
            stderr:
              "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
          }),
        ),
      ),
    ).toEqual({ status: "unavailable", reason: "Docker is not running. Start Docker and rescan." });
    expect(await inspectDockerImages(runner(result({ timedOut: true, code: null })))).toEqual({
      status: "unavailable",
      reason: "Docker did not answer within 10 seconds.",
    });
  });

  it("prunes only unused images and parses the reclaimed total", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const stdout = "Deleted Images:\nuntagged: alpine:3\n\nTotal reclaimed space: 1.2GB\n";
    expect(await pruneDockerImages(runner(result({ stdout }), calls))).toBe(1_200_000_000);
    expect(calls).toEqual([["image", "prune", "--all", "--force"]]);
    expect(await pruneDockerImages(runner(result({ stdout: "Total reclaimed space: 0B" })))).toBe(
      0,
    );
  });

  it("fails the prune when Docker is unavailable", async () => {
    await expect(
      pruneDockerImages(runner(result({ code: 1, stderr: "error during connect: dial unix" }))),
    ).rejects.toThrow("Docker is not running");
    await expect(pruneDockerImages(runner(new Error("Command not found: docker")))).rejects.toThrow(
      "The Docker CLI is not installed.",
    );
  });
});
