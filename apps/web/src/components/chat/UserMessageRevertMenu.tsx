import { memo } from "react";
import { FilesIcon, Undo2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export const UserMessageRevertMenu = memo(function UserMessageRevertMenu({
  onRevert,
  disabled,
  canRestoreFiles,
}: {
  onRevert: (restoreFiles: boolean) => void;
  disabled: boolean;
  canRestoreFiles: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Revert to this message"
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon aria-hidden="true" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
        <MenuItem onClick={() => onRevert(false)}>
          <Undo2Icon />
          Revert conversation, keep file changes
        </MenuItem>
        <MenuItem onClick={() => onRevert(true)} disabled={!canRestoreFiles}>
          <FilesIcon />
          <span className="flex flex-col">
            <span>Revert conversation and files</span>
            {!canRestoreFiles && (
              <span className="text-muted-foreground text-xs">Requires an isolated worktree</span>
            )}
          </span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
