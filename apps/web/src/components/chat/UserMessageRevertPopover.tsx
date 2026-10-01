import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { InfoIcon, Undo2Icon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { describeRevertFiles, describeRevertRemoval, type RevertImpact } from "./revertImpact";

const RESTORE_FILES_PREFERENCE_PREFIX = "f5:revert:restore-files:";

function readRestoreFilesPreference(key: string | undefined): boolean {
  if (!key) return false;
  try {
    return window.localStorage.getItem(`${RESTORE_FILES_PREFERENCE_PREFIX}${key}`) === "true";
  } catch {
    return false;
  }
}

function writeRestoreFilesPreference(key: string | undefined, restoreFiles: boolean): void {
  if (!key) return;
  try {
    window.localStorage.setItem(`${RESTORE_FILES_PREFERENCE_PREFIX}${key}`, String(restoreFiles));
  } catch {
    // Only a default; private mode or a full quota just forgets the choice.
  }
}

export interface UserMessageRevertPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Why revert is unavailable right now; the trigger stays visible and explains it. */
  disabledReason: string | null;
  canRestoreFiles: boolean;
  impact: RevertImpact | null;
  /** Forces the files choice, e.g. when reopened from a "Revert keeping files" toast. */
  presetRestoreFiles?: boolean | undefined;
  /** Scope for remembering the last files choice, typically the project id. */
  preferenceKey?: string | undefined;
  onConfirm: (restoreFiles: boolean) => void;
}

export const UserMessageRevertPopover = memo(function UserMessageRevertPopover({
  open,
  onOpenChange,
  disabledReason,
  canRestoreFiles,
  impact,
  presetRestoreFiles,
  preferenceKey,
  onConfirm,
}: UserMessageRevertPopoverProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);
  // Only an explicit pick is remembered. A forced "keep" (no worktree) or a
  // preset from a toast is not the user's preference for the project.
  const userChoseRef = useRef(false);
  const disabled = disabledReason !== null;
  const effectiveRestoreFiles = canRestoreFiles && restoreFiles;

  // Pick the starting choice whenever the popover opens, including programmatic
  // opens. Layout effect so the first painted frame already shows it.
  useLayoutEffect(() => {
    if (!open) return;
    userChoseRef.current = false;
    setRestoreFiles(presetRestoreFiles ?? readRestoreFilesPreference(preferenceKey));
  }, [open, presetRestoreFiles, preferenceKey]);

  const confirm = () => {
    if (userChoseRef.current) writeRestoreFilesPreference(preferenceKey, effectiveRestoreFiles);
    onOpenChange(false);
    onConfirm(effectiveRestoreFiles);
  };

  const onContentKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.repeat || event.nativeEvent.isComposing)
      return;
    // Enter on Cancel keeps its native meaning.
    if ((event.target as HTMLElement).closest("[data-revert-cancel]")) return;
    event.preventDefault();
    confirm();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && disabled) return;
        onOpenChange(nextOpen);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Revert to before this message"
                  aria-disabled={disabled || undefined}
                  data-revert-trigger=""
                  className={cn(disabled && "cursor-not-allowed opacity-50 hover:bg-transparent")}
                />
              }
            />
          }
        >
          <Undo2Icon aria-hidden="true" className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {disabledReason ?? "Revert to before this message"}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-80"
        aria-label="Revert to before this message"
        // Start on the files choice rather than on Revert, so the key that opened
        // the popover can't also confirm it.
        initialFocus={() =>
          contentRef.current?.querySelector<HTMLElement>("[data-slot=toggle][data-pressed]") ?? true
        }
      >
        <div
          ref={contentRef}
          className="flex flex-col gap-3 text-sm"
          data-slot="revert-popover"
          onKeyDown={onContentKeyDown}
        >
          <div className="flex flex-col gap-1">
            <p className="font-medium">Revert to before this message</p>
            <p className="text-muted-foreground text-xs">
              {describeRevertRemoval(impact)} The agent forgets them too.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <ToggleGroup
              variant="outline"
              size="xs"
              className="w-full *:flex-1"
              aria-label="What happens to your files"
              value={[effectiveRestoreFiles ? "restore" : "keep"]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "keep") {
                  userChoseRef.current = true;
                  setRestoreFiles(false);
                } else if (next === "restore" && canRestoreFiles) {
                  userChoseRef.current = true;
                  setRestoreFiles(true);
                }
              }}
            >
              <Toggle value="keep">Keep my files</Toggle>
              <Toggle value="restore" disabled={!canRestoreFiles}>
                Restore files
              </Toggle>
            </ToggleGroup>
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {describeRevertFiles(impact, effectiveRestoreFiles)}
              {canRestoreFiles ? null : " Restoring files needs an isolated worktree."}
            </p>
          </div>
          <p className="flex items-start gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-muted-foreground text-xs">
            <InfoIcon aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            Your prompt is saved so you can edit and resend it.
          </p>
          <div className="flex items-center justify-end gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-revert-cancel=""
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="button" size="xs" data-revert-confirm="" onClick={confirm}>
              Revert
              <Kbd className="h-4 min-w-4 bg-primary-foreground/15 text-[10px] text-primary-foreground">
                ↵
              </Kbd>
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
