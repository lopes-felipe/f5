import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import { Effect, Layer } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { startOwnedSetupScript } from "../ownedSetupScript.ts";
import {
  type ProjectSetupScriptRunnerShape,
  ProjectSetupScriptRunner,
} from "../Services/ProjectSetupScriptRunner.ts";

const makeProjectSetupScriptRunner = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const terminalManager = yield* TerminalManager;

  const runForThread: ProjectSetupScriptRunnerShape["runForThread"] = (input) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const project =
        (input.projectId
          ? readModel.projects.find((entry) => entry.id === input.projectId)
          : null) ??
        (input.projectCwd
          ? readModel.projects.find((entry) => entry.workspaceRoot === input.projectCwd)
          : null) ??
        null;

      if (!project) {
        return yield* Effect.fail(new Error("Project was not found for setup script execution."));
      }

      const script = setupProjectScript(project.scripts);
      if (!script) {
        return {
          status: "no-script",
        } as const;
      }

      const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
      const cwd = projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: input.worktreePath,
      });
      const env = projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: input.worktreePath,
      });

      if (script.async === false) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const tail: string[] = [];
            const owned = yield* Effect.acquireRelease(
              startOwnedSetupScript({
                command: script.command,
                cwd,
                env,
                onLine: (line) => {
                  tail.push(line);
                  if (tail.length > 20) tail.shift();
                },
              }),
              (script) => script.kill,
            );
            const code = yield* owned.exit;
            if (code !== 0) {
              return yield* Effect.fail(
                new Error(
                  `Setup script '${script.name}' failed (${code ?? "no exit code"}).${tail.length ? `\n${tail.join("\n")}` : ""}`,
                ),
              );
            }
            return {
              status: "completed",
              scriptId: script.id,
              scriptName: script.name,
              cwd,
            } as const;
          }),
        );
      }

      yield* terminalManager.open({
        threadId: input.threadId,
        terminalId,
        cwd,
        env,
      });
      yield* terminalManager.write({
        threadId: input.threadId,
        terminalId,
        data: `${script.command}\r`,
      });

      return {
        status: "started",
        scriptId: script.id,
        scriptName: script.name,
        terminalId,
        cwd,
      } as const;
    });

  return {
    runForThread,
  } satisfies ProjectSetupScriptRunnerShape;
});

export const ProjectSetupScriptRunnerLive = Layer.effect(
  ProjectSetupScriptRunner,
  makeProjectSetupScriptRunner,
);
