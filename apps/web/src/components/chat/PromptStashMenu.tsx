import { ArchiveIcon, ArchiveRestoreIcon, Trash2Icon } from "lucide-react";

import type { PromptStashEntry } from "~/composerDraftStore";

import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";

function formatStashTime(createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return "Saved prompt";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function PromptStashMenu(props: {
  readonly stashes: ReadonlyArray<PromptStashEntry>;
  readonly canStash: boolean;
  readonly disabled?: boolean;
  readonly stashShortcutLabel?: string | null;
  readonly onStash: () => void;
  readonly onRestore: (stashId: string) => void;
  readonly onDelete: (stashId: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="Saved prompts"
            title="Saved prompts"
            disabled={props.disabled}
          />
        }
      >
        <ArchiveRestoreIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <MenuItem disabled={!props.canStash || props.disabled} onClick={props.onStash}>
          <ArchiveIcon aria-hidden="true" />
          Stash current prompt
          {props.stashShortcutLabel ? (
            <MenuShortcut>{props.stashShortcutLabel}</MenuShortcut>
          ) : null}
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Saved prompts</MenuGroupLabel>
          {props.stashes.length === 0 ? (
            <MenuItem disabled>No saved prompts</MenuItem>
          ) : (
            props.stashes.map((stash) => (
              <MenuSub key={stash.id}>
                <MenuSubTrigger className="min-w-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{stash.preview}</span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {formatStashTime(stash.createdAt)}
                    </span>
                  </span>
                </MenuSubTrigger>
                <MenuSubPopup className="w-44">
                  <MenuItem onClick={() => props.onRestore(stash.id)}>
                    <ArchiveRestoreIcon aria-hidden="true" />
                    Restore
                  </MenuItem>
                  <MenuItem variant="destructive" onClick={() => props.onDelete(stash.id)}>
                    <Trash2Icon aria-hidden="true" />
                    Delete saved prompt
                  </MenuItem>
                </MenuSubPopup>
              </MenuSub>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
