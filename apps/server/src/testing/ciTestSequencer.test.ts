import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BaseSequencer, type TestSpecification, type Vitest } from "vitest/node";
import { DurationSequencer } from "../../scripts/ciTestSequencer.ts";
import timings from "../../test-timings.json";
import { allocateShards } from "../../../../scripts/lib/ci-test-sharding.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = globSync("src/**/*.test.ts", { cwd: root }).map((file) => file.replaceAll("\\", "/"));

describe("server CI shard inventory", () => {
  it("retains Vitest's ordering for unsharded local and macOS runs", async () => {
    const specs = [{ moduleId: join(root, files[0]!) }] as TestSpecification[];
    const original = vi.spyOn(BaseSequencer.prototype, "sort").mockResolvedValueOnce(specs);
    try {
      const sequencer = new DurationSequencer({ config: { root } } as Vitest);
      expect(await sequencer.sort(specs)).toBe(specs);
      expect(original).toHaveBeenCalledWith(specs);
    } finally {
      original.mockRestore();
    }
  });
  it.each([
    ["linux", 2],
    ["win32", 3],
  ] as const)("covers the complete current inventory exactly once on %s", (platform, count) => {
    const shards = allocateShards(files, timings.platforms[platform].durationsMs, count);
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(shards.every((shard) => shard.length > 0)).toBe(true);
  });

  it("connects Vitest's shard selection and expensive-first sorting to the allocator", async () => {
    const specs = files.map((file) => ({ moduleId: join(root, file) }) as TestSpecification);
    const durations =
      timings.platforms[process.platform as keyof typeof timings.platforms]?.durationsMs ?? {};
    const expected = allocateShards(files, durations, 3);
    const selected: TestSpecification[] = [];
    for (const index of [1, 2, 3]) {
      const sequencer = new DurationSequencer({
        config: { root, shard: { index, count: 3 } },
      } as Vitest);
      const shard = await sequencer.sort(await sequencer.shard(specs));
      expect(shard.map((file) => file.moduleId)).toEqual(
        expected[index - 1]!.map((file) => join(root, file)),
      );
      selected.push(...shard);
    }
    expect(selected.map((file) => file.moduleId).sort()).toEqual(
      specs.map((file) => file.moduleId).sort(),
    );
  });
});
