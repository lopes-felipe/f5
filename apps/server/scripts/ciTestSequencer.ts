import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { allocateShards, sortByDuration } from "../../../scripts/lib/ci-test-sharding.ts";
import timings from "../test-timings.json" with { type: "json" };

export class DurationSequencer extends BaseSequencer {
  private key(file: TestSpecification): string {
    return relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/");
  }

  private durations() {
    return timings.platforms[process.platform as keyof typeof timings.platforms]?.durationsMs ?? {};
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    if (!timings.enabled) return super.shard(files);
    const selected = new Set(
      allocateShards(
        files.map((file) => this.key(file)),
        this.durations(),
        shard.count,
      )[shard.index - 1],
    );
    return files.filter((file) => selected.has(this.key(file)));
  }

  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    // Keep Vitest's cache-aware ordering for local runs and the full macOS suite.
    if (!this.ctx.config.shard || !timings.enabled) return super.sort(files);
    const order = new Map(
      sortByDuration(
        files.map((file) => this.key(file)),
        this.durations(),
      ).map((file, index) => [file, index]),
    );
    return [...files].sort((a, b) => order.get(this.key(a))! - order.get(this.key(b))!);
  }
}
