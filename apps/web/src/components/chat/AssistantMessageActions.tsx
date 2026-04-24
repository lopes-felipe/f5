import { memo } from "react";
import { CheckIcon, CopyIcon, EllipsisIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

export const AssistantMessageActions = memo(function AssistantMessageActions({
  rawText,
}: {
  rawText: string;
}) {
  const isDisabled = rawText.length === 0;
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Raw markdown copied",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy raw markdown",
        description:
          error instanceof Error ? error.message : "An unexpected clipboard error occurred.",
      });
    },
  });

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            title="Message actions"
            aria-label="Message actions"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="start">
        <MenuItem onClick={() => copyToClipboard(rawText)} disabled={isDisabled}>
          {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy raw markdown"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
