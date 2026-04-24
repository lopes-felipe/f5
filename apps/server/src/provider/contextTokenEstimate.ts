import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ProviderInteractionMode, ProviderKind } from "@t3tools/contracts";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";

import {
  buildClaudeAssistantInstructions,
  buildCodexAssistantInstructions,
  type SharedInstructionInput,
} from "./sharedAssistantContract.ts";

const AGENTS_FILE_NAME = "AGENTS.md";

async function readWorkspaceAgentsCharacters(cwd: string | undefined): Promise<number> {
  if (!cwd) {
    return 0;
  }

  const absoluteCwd = path.resolve(cwd);
  const agentFilePaths: string[] = [];
  let currentDirectory = absoluteCwd;

  while (true) {
    agentFilePaths.push(path.join(currentDirectory, AGENTS_FILE_NAME));
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  const contents = await Promise.all(
    agentFilePaths.map(async (agentFilePath) => {
      try {
        return await readFile(agentFilePath, "utf8");
      } catch {
        return "";
      }
    }),
  );

  return contents.reduce((sum, content) => sum + content.length, 0);
}

export async function estimateProviderInstructionTokens(input: {
  readonly provider: ProviderKind;
  readonly interactionMode?: ProviderInteractionMode;
  readonly instructionContext?: Partial<SharedInstructionInput>;
  readonly model?: string | null | undefined;
  readonly effort?: string | null | undefined;
}): Promise<number> {
  const sharedInstructionInput: SharedInstructionInput = {
    ...input.instructionContext,
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    currentDate: input.instructionContext?.currentDate ?? new Date().toISOString().slice(0, 10),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort
      ? { effort: input.effort }
      : input.provider === "codex"
        ? { effort: "medium" }
        : {}),
  };
  const instructionText =
    input.provider === "claudeAgent"
      ? buildClaudeAssistantInstructions(sharedInstructionInput)
      : buildCodexAssistantInstructions(sharedInstructionInput);
  const workspaceAgentsCharacters = await readWorkspaceAgentsCharacters(sharedInstructionInput.cwd);

  return roughTokenEstimateFromCharacters(instructionText.length + workspaceAgentsCharacters);
}
