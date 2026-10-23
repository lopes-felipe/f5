import type { SourceControlProviderIdentity } from "@t3tools/contracts";
import {
  buildNewThreadLink,
  PROMPT_LINK_DEV_SCHEME,
  PROMPT_LINK_MAX_PROMPT_LENGTH,
  PROMPT_LINK_SCHEME,
  type PromptLinkRepository,
} from "@t3tools/shared/promptLinks";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

import { toastManager } from "../ui/toast";

/** The scheme this build registers, so a copied link opens the same kind of build. */
export const promptLinkScheme = import.meta.env.DEV ? PROMPT_LINK_DEV_SCHEME : PROMPT_LINK_SCHEME;

/** A shareable link to a prompt, or null when the prompt is empty or too long for one. */
export function promptLinkFor(
  prompt: string,
  context?: {
    readonly repository?: PromptLinkRepository | null;
    readonly provider?: string | null;
    readonly model?: string | null;
  },
): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > PROMPT_LINK_MAX_PROMPT_LENGTH) return null;
  return buildNewThreadLink({ prompt: trimmed, ...context, scheme: promptLinkScheme });
}

/** The GitHub repository a project's remote names, for a link's `repo` parameter. */
export function promptLinkRepositoryOf(
  identity: SourceControlProviderIdentity | undefined | null,
): PromptLinkRepository | null {
  if (identity?.kind !== "github" || identity.host?.toLowerCase() !== "github.com") return null;
  return identity.owner && identity.repository
    ? { owner: identity.owner, name: identity.repository }
    : null;
}

export async function copyPromptLink(link: string | null): Promise<void> {
  if (link === null) {
    toastManager.add({
      type: "warning",
      title: "Nothing to share",
      description: `A prompt link needs a prompt of at most ${PROMPT_LINK_MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters.`,
    });
    return;
  }
  try {
    await writeTextToClipboard(link);
    toastManager.add({ type: "success", title: "Prompt link copied" });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not copy the prompt link",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}
