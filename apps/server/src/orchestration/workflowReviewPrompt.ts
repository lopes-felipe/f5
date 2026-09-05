import type { OrchestrationThread } from "@t3tools/contracts";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";

import { truncatePatchAtFileBoundary } from "../git/patchTruncation.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { buildCodeReviewPrompt } from "./workflowPrompts.ts";
import {
  workflowArtifactFit,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
} from "./workflowSharedUtils.ts";

/** Budget the outgoing view, never the persisted checkpoint artifact. */
export function prepareCodeReviewPrompt(
  input: Parameters<typeof buildCodeReviewPrompt>[0] & {
    readonly enforceArtifactBudget: boolean;
    readonly thread?: Pick<OrchestrationThread, "estimatedContextTokens"> | null | undefined;
  },
):
  | { readonly prompt: string; readonly artifacts: ReadonlyArray<string> }
  | OrchestrationCommandInvariantError {
  const fixedArtifacts = [input.requirementPrompt, input.mergedPlanMarkdown];
  const fit = workflowArtifactFit({
    artifacts: fixedArtifacts,
    targetSlot: input.reviewerSlot,
    thread: input.thread ?? null,
  });
  const remainingTokens = fit.availableTokens - fit.estimatedTokens;
  const artifactFits = (characters: number) =>
    !input.enforceArtifactBudget || roughTokenEstimateFromCharacters(characters) <= remainingTokens;
  const render = (reviewArtifact: typeof input.reviewArtifact) =>
    buildCodeReviewPrompt({ ...input, reviewArtifact });
  const result = (prompt: string, patch: string) => ({
    prompt,
    artifacts: [...fixedArtifacts, patch],
  });
  const original = render(input.reviewArtifact);
  if (
    original.length <= WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT &&
    artifactFits(input.reviewArtifact.patchText.length)
  ) {
    return result(original, input.reviewArtifact.patchText);
  }

  // A fixed notice makes the remainder exact, including metadata and separators.
  const artifact = {
    ...input.reviewArtifact,
    patchText: "",
    truncated: true,
    truncationReason: [
      input.reviewArtifact.truncationReason,
      `Additional patch content omitted to fit the review prompt budget (supplied patch: ${Buffer.byteLength(input.reviewArtifact.patchText)} UTF-8 bytes).`,
    ]
      .filter(Boolean)
      .join(" "),
  };
  const fixedPrompt = render(artifact);
  if (fixedPrompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT || !artifactFits(0)) {
    return new OrchestrationCommandInvariantError({
      commandType: "workflow.turn.start",
      detail: `Implementation review inputs cannot fit without shortening the requirement or approved plan: requirement ${input.requirementPrompt.length} characters, plan ${input.mergedPlanMarkdown.length} characters, instructions and metadata ${fixedPrompt.length - input.requirementPrompt.length - input.mergedPlanMarkdown.length} characters; maximum rendered prompt ${WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT} characters. Fixed artifacts require an estimated ${fit.estimatedTokens} tokens; ${fit.availableTokens} available. Shorten the requirement or approved plan${input.enforceArtifactBudget ? ", or select a reviewer with more available context" : ""}, then retry review setup.`,
    });
  }

  let low = 0;
  let high = WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT - fixedPrompt.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (artifactFits(middle)) low = middle;
    else high = middle - 1;
  }
  // A UTF-8 byte allowance is conservative for the UTF-16 character ceiling.
  // The persisted source's truncation flag is metadata, not a partial stdout flag.
  const bounded = truncatePatchAtFileBoundary(input.reviewArtifact.patchText, false, low);
  const prompt = render({ ...artifact, patchText: bounded.patch });
  if (prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT || !artifactFits(bounded.patch.length)) {
    return new OrchestrationCommandInvariantError({
      commandType: "workflow.turn.start",
      detail: "Implementation review prompt budgeting failed to satisfy the final input limits.",
    });
  }
  return result(prompt, bounded.patch);
}
