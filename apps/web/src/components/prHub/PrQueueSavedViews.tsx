import { useState, type FormEvent } from "react";
import { BookmarkPlusIcon, EllipsisIcon, PencilIcon, Trash2Icon } from "lucide-react";

import {
  MAX_PR_SAVED_VIEWS,
  MAX_PR_SAVED_VIEW_NAME_LENGTH,
  normalizePrSavedViewName,
  type PrSavedViewSetting,
} from "../../lib/prSavedViews";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { UnderlineTabs } from "../ui/underline-tabs";
import type { PrQueueFilters } from "./prQueueSearch";

const QUEUE_TAB = "queue";

/** Asks for a view's name: for a new view, or to rename one. */
function ViewNameDialog({
  title,
  description,
  initialName,
  submitLabel,
  takenNames,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  initialName: string;
  submitLabel: string;
  takenNames: readonly string[];
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const normalized = normalizePrSavedViewName(name);
  const taken = takenNames.some((other) => other.toLowerCase() === normalized.toLowerCase());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!normalized || taken) return;
    onSubmit(normalized);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2">
            <Input
              aria-label="View name"
              autoFocus
              value={name}
              maxLength={MAX_PR_SAVED_VIEW_NAME_LENGTH}
              placeholder="Frontend reviews"
              onChange={(event) => setName(event.target.value)}
            />
            {taken ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                Another view already has this name.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!normalized || taken}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Saved searches as tabs under the toolbar: Queue (no filters), one tab per saved view
 * with how many of its pull requests need you, and Save view for the current filters.
 * Hidden until there is a view to show or filters to save.
 */
export function PrQueueSavedViews({
  views,
  activeView,
  filters,
  isFiltered,
  counts,
  onSelectQueue,
  onSelectView,
  onChange,
}: {
  views: readonly PrSavedViewSetting[];
  /** The view the queue shows unchanged, if any. */
  activeView: PrSavedViewSetting | null;
  /** The search and filters applied now: what Save view would keep. */
  filters: PrQueueFilters;
  isFiltered: boolean;
  counts: Readonly<Record<string, number>> | undefined;
  onSelectQueue: () => void;
  onSelectView: (view: PrSavedViewSetting) => void;
  /**
   * Changes the stored views. The update gets the views as they are stored at that
   * moment, which may be later than this render (Undo). `select` is shown afterwards.
   */
  onChange: (
    update: (current: readonly PrSavedViewSetting[]) => readonly PrSavedViewSetting[],
    select?: PrSavedViewSetting,
  ) => void;
}) {
  const [dialog, setDialog] = useState<"save" | "rename" | null>(null);
  if (views.length === 0 && !isFiltered) return null;
  const full = views.length >= MAX_PR_SAVED_VIEWS;
  const canSave = isFiltered && !activeView && !full;
  const names = views.map((view) => view.name);

  const save = (name: string) => {
    const view: PrSavedViewSetting = {
      id: randomUUID(),
      name,
      query: Object.fromEntries(
        Object.entries(filters).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
    setDialog(null);
    onChange((current) => [...current, view], view);
  };
  const rename = (name: string) => {
    if (!activeView) return;
    const { id } = activeView;
    setDialog(null);
    onChange((current) => current.map((view) => (view.id === id ? { ...view, name } : view)));
  };
  const remove = () => {
    if (!activeView) return;
    const removed = activeView;
    const index = views.indexOf(removed);
    onChange((current) => current.filter((view) => view.id !== removed.id));
    const toastId = toastManager.add({
      type: "success",
      title: `Deleted the view "${removed.name}"`,
      timeout: 8000,
      actionProps: {
        children: "Undo",
        onClick: (event) => {
          event.preventDefault();
          toastManager.close(toastId);
          // Undo may run after other changes: it goes back where it was among those.
          onChange((current) =>
            current.some((view) => view.id === removed.id) || current.length >= MAX_PR_SAVED_VIEWS
              ? current
              : [...current.slice(0, index), removed, ...current.slice(index)],
          );
        },
      },
    });
  };

  return (
    <>
      <UnderlineTabs
        aria-label="Saved views"
        className="shrink-0 px-4"
        scrollable
        tabs={[
          { value: QUEUE_TAB, label: "Queue" },
          ...views.map((view) => ({
            value: view.id,
            label: view.name,
            adornment: counts?.[view.id] ? (
              <span
                className="rounded-full bg-secondary px-1.5 text-2xs text-secondary-foreground tabular-nums"
                title="Pull requests in this view that need you"
              >
                {counts[view.id]}
              </span>
            ) : undefined,
          })),
        ]}
        value={activeView?.id ?? (isFiltered ? "" : QUEUE_TAB)}
        onValueChange={(value) => {
          const view = views.find((candidate) => candidate.id === value);
          if (view) onSelectView(view);
          else onSelectQueue();
        }}
        trailing={
          activeView ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Options for the view ${activeView.name}`}
                  />
                }
              >
                <EllipsisIcon aria-hidden="true" />
              </MenuTrigger>
              <MenuPopup align="end" className="min-w-40">
                <MenuItem onClick={() => setDialog("rename")}>
                  <PencilIcon /> Rename…
                </MenuItem>
                <MenuItem onClick={remove}>
                  <Trash2Icon /> Delete view
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              disabled={!canSave}
              title={
                full
                  ? `You can keep up to ${MAX_PR_SAVED_VIEWS} views. Delete one to save another.`
                  : isFiltered
                    ? "Keep this search and these filters as a tab"
                    : "Search or filter the queue to save a view"
              }
              onClick={() => setDialog("save")}
            >
              <BookmarkPlusIcon /> Save view
            </Button>
          )
        }
      />
      {dialog === "save" ? (
        <ViewNameDialog
          title="Save view"
          description="Keeps the current search and filters as a tab above the queue."
          initialName=""
          submitLabel="Save"
          takenNames={names}
          onSubmit={save}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "rename" && activeView ? (
        <ViewNameDialog
          title="Rename view"
          description="The view keeps its search and filters."
          initialName={activeView.name}
          submitLabel="Rename"
          takenNames={names.filter((name) => name !== activeView.name)}
          onSubmit={rename}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}
