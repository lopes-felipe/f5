import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
  WorktreePreparations,
  needsPreparation,
  type PreparationAllocation,
} from "../Services/WorktreePreparations.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeWorktreePreparations, WorktreePreparationsLive } from "./WorktreePreparations.ts";

const allocation: PreparationAllocation = {
  operationId: "operation-1",
  repositoryIdentity: "/repo/.git",
  projectIdentity: "/repo",
  owner: "thread:one",
  requestedBase: "main",
  baseOid: "base-oid",
  path: "/worktrees/one",
  branch: "f5/one",
  namingIntent: "generated",
  setupIdentity: "echo setup",
  runSetupScript: true,
};
it.layer(WorktreePreparationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "worktree preparation receipts",
  (it) => {
    it.effect(
      "persists allocation before checkout, checks versions and rehydrates completion",
      () =>
        Effect.gen(function* () {
          const receipts = yield* WorktreePreparations;
          const allocated = yield* receipts.allocate(allocation);
          expect(yield* receipts.latest(allocation.path)).toEqual(allocated);
          expect(allocated.createdCheckout).toBe(false);
          expect(
            yield* receipts.branchReserved(allocation.repositoryIdentity, allocation.branch),
          ).toBe(true);
          const created = yield* receipts.update(allocated, {
            phase: "checkout_created",
            createdCheckout: true,
          });
          expect(needsPreparation(created)).toBe(true);
          expect(
            (yield* receipts.update(allocated, { phase: "completed" }).pipe(Effect.exit))._tag,
          ).toBe("Failure");
          const done = yield* receipts.update(created, {
            phase: "completed",
            result: JSON.stringify({ path: allocation.path }),
          });
          const restarted = yield* makeWorktreePreparations;
          expect(yield* restarted.latest(allocation.path)).toEqual(done);
          expect(needsPreparation(done)).toBe(false);
          expect(
            yield* receipts.branchReserved(allocation.repositoryIdentity, allocation.branch),
          ).toBe(false);
        }),
    );
    it.effect("reconciles only running scripts and keeps their ownership proof", () =>
      Effect.gen(function* () {
        const receipts = yield* WorktreePreparations;
        const request = {
          ...allocation,
          operationId: "interrupted",
          owner: "thread:interrupted",
          branch: "f5/interrupted",
          path: "/worktrees/interrupted",
        };
        const created = yield* receipts.update(yield* receipts.allocate(request), {
          phase: "checkout_created",
          createdCheckout: true,
        });
        yield* receipts.update(created, { phase: "setup_running" });
        const restarted = yield* makeWorktreePreparations;
        yield* restarted.reconcile;
        const interrupted = yield* restarted.latest(request.path);
        expect(interrupted).toMatchObject({
          phase: "setup_indeterminate",
          createdCheckout: true,
          baseOid: allocation.baseOid,
          version: 3,
        });
        expect(interrupted?.error).toContain("external effects");
        expect(needsPreparation(interrupted)).toBe(true);
      }),
    );
    it.effect("rejects changed owners and branch reservations without overwriting receipts", () =>
      Effect.gen(function* () {
        const receipts = yield* WorktreePreparations;
        const request = {
          ...allocation,
          operationId: "reserved",
          owner: "thread:reserved",
          branch: "f5/reserved",
          path: "/worktrees/reserved",
        };
        const reserved = yield* receipts.allocate(request);
        expect(
          (yield* receipts.allocate({ ...request, owner: "thread:other" }).pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(
          (yield* receipts
            .allocate({ ...request, operationId: "conflicting", path: "/worktrees/other" })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(yield* receipts.latest(request.path)).toEqual(reserved);
      }),
    );
    it.effect("reserves a name before fetch and records the resolved OID before checkout", () =>
      Effect.gen(function* () {
        const receipts = yield* WorktreePreparations;
        const request = {
          ...allocation,
          owner: "thread:preflight",
          operationId: "preflight",
          branch: "f5/preflight",
          path: "/worktrees/preflight",
          baseOid: null,
        };
        const reserved = yield* receipts.allocate(request);
        expect(reserved.baseOid).toBeNull();
        const fetched = yield* receipts.allocate({ ...request, baseOid: "resolved-oid" });
        expect(fetched).toMatchObject({ baseOid: "resolved-oid", version: 1, phase: "allocated" });
        expect(yield* receipts.latest(request.path)).toEqual(fetched);
      }),
    );
  },
);
