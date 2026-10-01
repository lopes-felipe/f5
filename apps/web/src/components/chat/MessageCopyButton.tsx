import { memo } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

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
