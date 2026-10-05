import { useMemo, useState } from "react";

import { useServerKeybindings } from "../keybindings";
import { useShortcutsDialogStore } from "../shortcutsDialogStore";
import { buildShortcutSections } from "./shortcutsDialog.logic";
import { SectionLabel } from "./ui/section-label";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";

/**
 * Keyboard shortcut reference. Lists the resolved bindings (so user
 * overrides from keybindings.json show up), grouped by area, with a filter.
 * Loaded lazily: it is only mounted the first time it opens.
 */
export default function ShortcutsDialog() {
  const open = useShortcutsDialogStore((state) => state.open);
  const setOpen = useShortcutsDialogStore((state) => state.setOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? <ShortcutsDialogContent /> : null}
    </Dialog>
  );
}

function ShortcutsDialogContent() {
  const keybindings = useServerKeybindings();
  const [query, setQuery] = useState("");
  const sections = useMemo(
    () => buildShortcutSections(keybindings, { query }),
    [keybindings, query],
  );

  return (
    <DialogPopup className="max-w-2xl" data-testid="shortcuts-dialog">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Change any of these under Settings, Integrations, Keybindings.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-5">
        <Input
          aria-label="Filter shortcuts"
          autoFocus
          nativeInput
          placeholder="Filter shortcuts"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {sections.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            No shortcuts match “{query.trim()}”.
          </p>
        ) : (
          <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            {sections.map((section) => (
              <section key={section.id} aria-label={section.title} className="min-w-0">
                <SectionLabel className="mb-1.5">{section.title}</SectionLabel>
                <dl className="space-y-0.5">
                  {section.entries.map((entry) => (
                    <div
                      key={entry.command}
                      className="flex min-h-7 items-center justify-between gap-3 text-sm"
                      data-shortcut-command={entry.command}
                    >
                      <dt className="min-w-0 truncate text-foreground">
                        {entry.label}
                        {entry.context ? (
                          <span className="ml-1.5 text-muted-foreground text-xs">
                            {entry.context}
                          </span>
                        ) : null}
                      </dt>
                      <dd className="flex shrink-0 items-center">
                        <Kbd>{entry.shortcut}</Kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        )}
      </DialogPanel>
    </DialogPopup>
  );
}
