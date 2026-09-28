import { CheckIcon, CopyIcon } from "lucide-react";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { toastManager } from "./ui/toast";

export function CopyPathButton({ path }: { path: string }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard({
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy path", description: error.message }),
  });
  return (
    <button
      type="button"
      title={isCopied ? "Copied" : `Copy path: ${path}`}
      aria-label={`Copy path: ${path}`}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        copyToClipboard(path);
      }}
    >
      {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
}
