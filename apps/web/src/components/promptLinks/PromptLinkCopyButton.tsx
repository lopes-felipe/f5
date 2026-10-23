import type { PromptLinkRepository } from "@t3tools/shared/promptLinks";
import { LinkIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import { copyPromptLink, promptLinkFor } from "./copyPromptLink";

/** Copies a link that opens a new thread with this message as its prompt. */
export const PromptLinkCopyButton = memo(function PromptLinkCopyButton({
  prompt,
  repository,
}: {
  prompt: string;
  repository: PromptLinkRepository | null;
}) {
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      onClick={() => void copyPromptLink(promptLinkFor(prompt, { repository }))}
      title="Copy prompt link"
      aria-label="Copy prompt link"
    >
      <LinkIcon aria-hidden="true" className="size-3.5" />
    </Button>
  );
});
