import type { KeybindingCommand, ProjectId, ProjectScript, ServerConfig } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { NewProjectScriptInput } from "~/components/ProjectScriptDialog";
import { toastManager } from "~/components/ui/toast";
import {
  decodeProjectScriptKeybindingRule,
  replaceProjectScriptKeybinding,
} from "~/lib/projectScriptKeybindings";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";

export interface ProjectScriptMutationTarget {
  readonly id: ProjectId;
  readonly scripts: ReadonlyArray<ProjectScript>;
}

/** Add, update, and delete a project's actions, keeping their keybindings in sync. */
export function useProjectScriptMutations(project: ProjectScriptMutationTarget | null) {
  const queryClient = useQueryClient();

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand | null;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      await replaceProjectScriptKeybinding({
        server: api.server,
        customKeybindings:
          queryClient.getQueryData<ServerConfig>(serverQueryKeys.config())?.customKeybindings ?? [],
        command: input.keybindingCommand,
        rule: keybindingRule,
      });
      await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
    },
    [queryClient],
  );

  const addScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!project) return;
      const nextId = nextProjectScriptId(
        input.name,
        project.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
        ...(input.runOnWorktreeSettle ? { runOnWorktreeSettle: true } : {}),
        stopOnSettle: input.stopOnSettle ?? false,
        ...(input.runOnWorktreeCreate && !input.async ? { async: false } : {}),
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...project.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...project.scripts, nextScript];

      await persistProjectScripts({
        projectId: project.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [project, persistProjectScripts],
  );

  const updateScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!project) return;
      const existingScript = project.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const {
        async: _previousAsync,
        runOnWorktreeSettle: _previousSettle,
        ...existingWithoutAsync
      } = existingScript;
      const updatedScript: ProjectScript = {
        ...existingWithoutAsync,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
        ...(input.runOnWorktreeSettle ? { runOnWorktreeSettle: true } : {}),
        stopOnSettle: input.stopOnSettle ?? false,
        ...(input.runOnWorktreeCreate && !input.async ? { async: false } : {}),
      };
      const nextScripts = project.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: project.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [project, persistProjectScripts],
  );

  const deleteScript = useCallback(
    async (scriptId: string) => {
      if (!project) return;
      const nextScripts = project.scripts.filter((script) => script.id !== scriptId);

      const deletedName = project.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: project.id,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [project, persistProjectScripts],
  );

  return { addScript, updateScript, deleteScript };
}
