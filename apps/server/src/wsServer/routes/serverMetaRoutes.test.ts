import { DEFAULT_SERVER_SETTINGS, ProjectId, WS_METHODS } from "@t3tools/contracts";
import { Cause, Effect, Exit, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import { serverMetaRoutes } from "./serverMetaRoutes.ts";

const fakeWs = {} as WebSocket;

function makeRoutes(overrides?: {
  readonly getProjectSkillSyncServiceIfReady?: Effect.Effect<Option.Option<never>>;
  readonly getInstance?: (id: string) => Effect.Effect<unknown>;
  readonly projects?: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly deletedAt: string | null;
  }>;
}) {
  const projectId = ProjectId.make("project-1");
  return serverMetaRoutes({
    serverConfig: {} as never,
    cwd: "/tmp",
    keybindingsConfigPath: "/tmp/keybindings.json",
    availableEditors: [],
    sql: {} as SqlClient.SqlClient,
    clientDiagnosticsReporter: { report: () => Effect.void } as never,
    currentRuntimeReadiness: () => ({ phase: "ready" }) as never,
    keybindingsManager: {} as never,
    providerAdvisoryProjection: {} as never,
    providerInstanceRegistry: {
      getInstance: overrides?.getInstance ?? (() => Effect.void),
    } as never,
    providerRegistry: {} as never,
    providerUpdateAdvisor: {} as never,
    harnessValidation: {} as never,
    serverSettings: {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    } as never,
    themeBackgrounds: { paths: async () => ({}) },
    projectionProjects: {
      getById: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Demo",
            workspaceRoot: "/tmp/nonexistent-project-settings-test",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          } as never),
        ),
    } as never,
    computerAutomationBroker: Option.none(),
    getProjectSkillSyncServiceIfReady:
      overrides?.getProjectSkillSyncServiceIfReady ?? Effect.succeed(Option.none()),
    runtime: Effect.succeed({
      orchestrationEngine: {
        getReadModel: () =>
          Effect.succeed({
            projects: overrides?.projects ?? [
              { id: projectId, workspaceRoot: "/tmp/repo", deletedAt: null },
            ],
          } as never),
      },
    }),
  });
}

describe("serverMetaRoutes", () => {
  it("returns empty skillScanWarnings for serverGetProjectSettings when skill sync is not ready", async () => {
    const routes = makeRoutes({
      getProjectSkillSyncServiceIfReady: Effect.succeed(Option.none()),
    });

    const result = (await Effect.runPromise(
      routes[WS_METHODS.serverGetProjectSettings](
        {
          _tag: WS_METHODS.serverGetProjectSettings,
          projectId: ProjectId.make("project-1"),
        },
        fakeWs,
      ),
    )) as { readonly skillScanWarnings: ReadonlyArray<unknown> };
    expect(result.skillScanWarnings).toEqual([]);
  });

  it("validates Codex capability and resolves projectRoot for serverTrustProviderHooks", async () => {
    const trustHooks = vi.fn(() => Effect.succeed({ trusted: ["hook-a"] } as never));
    const routes = makeRoutes({
      getInstance: (id) =>
        Effect.succeed(
          id === "codex-1"
            ? { instanceId: "codex-1", driverKind: "codex", trustHooks }
            : { instanceId: "claude-1", driverKind: "claudeAgent" },
        ),
    });

    const rejectedExit = await Effect.runPromiseExit(
      routes[WS_METHODS.serverTrustProviderHooks](
        {
          _tag: WS_METHODS.serverTrustProviderHooks,
          instanceId: "claude-1",
          hooks: [],
        } as never,
        fakeWs,
      ),
    );
    expect(Exit.isFailure(rejectedExit)).toBe(true);
    if (Exit.isFailure(rejectedExit)) {
      const error = Cause.squash(rejectedExit.cause);
      expect(error).toBeInstanceOf(RouteRequestError);
      expect((error as RouteRequestError).message).toBe(
        "Hook approval is only available for a configured Codex provider.",
      );
    }

    const result = await Effect.runPromise(
      routes[WS_METHODS.serverTrustProviderHooks](
        {
          _tag: WS_METHODS.serverTrustProviderHooks,
          instanceId: "codex-1",
          projectId: ProjectId.make("project-1"),
          hooks: [{ id: "hook-a" }],
        } as never,
        fakeWs,
      ),
    );
    expect(trustHooks).toHaveBeenCalledWith({
      projectRoot: "/tmp/repo",
      hooks: [{ id: "hook-a" }],
    });
    expect(result).toEqual({ trusted: ["hook-a"] });
  });
});
