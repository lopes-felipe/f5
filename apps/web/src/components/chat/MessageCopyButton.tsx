import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy message",
        description:
          error instanceof Error ? error.message : "An unexpected clipboard error occurred.",
      });
    },
  });

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      onClick={() => copyToClipboard(text)}
      title="Copy message"
      aria-label="Copy message"
    >
      {isCopied ? (
        <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3.5" />
      )}
    </Button>
  );
});
