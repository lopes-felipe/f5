import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { acquireInstanceLock } from "../../profiles/InstanceLock.ts";
import { withRepositoryLifecycleLock } from "./WorktreeLifecycleCoordinator.ts";

it("refuses a repository lock held by another profile and releases its own lock", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f5-repository-lock-"));
  const common = path.join(base, "common");
  await fs.mkdir(common);
  const key = createHash("sha256")
    .update(await fs.realpath(common))
    .digest("hex");
  const lockPath = path.join(base, "locks", `${key}.sqlite`);
  const otherProfile = await acquireInstanceLock(lockPath);
  try {
    await expect(
      Effect.runPromise(withRepositoryLifecycleLock(base, common, Effect.succeed("unexpected"))),
    ).rejects.toThrow(/another F5 profile/i);
    otherProfile.release();
    expect(
      await Effect.runPromise(
        withRepositoryLifecycleLock(base, common, Effect.succeed("acquired")),
      ),
    ).toBe("acquired");
    const after = await acquireInstanceLock(lockPath);
    after.release();
  } finally {
    otherProfile.release();
    await fs.rm(base, { recursive: true, force: true });
  }
});

it("serializes two same-process repository mutations beyond the cross-profile retry window", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f5-repository-serial-"));
  try {
    const order: string[] = [];
    await Effect.runPromise(
      Effect.all(
        [1, 2].map((id) =>
          withRepositoryLifecycleLock(
            base,
            base,
            Effect.gen(function* () {
              order.push("start" + id);
              yield* Effect.sleep("650 millis");
              order.push("end" + id);
            }),
          ),
        ),
        { concurrency: 2 },
      ),
    );
    expect([
      ["start1", "end1", "start2", "end2"],
      ["start2", "end2", "start1", "end1"],
    ]).toContainEqual(order);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
