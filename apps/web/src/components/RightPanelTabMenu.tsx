import { useState } from "react";
import type { RightPanelSurface } from "../rightPanelStore";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";

export function RightPanelTabMenu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  surfaces: readonly RightPanelSurface[];
  title: (surface: RightPanelSurface) => string;
  onActivate: (surface: RightPanelSurface) => void;
}) {
  const [query, setQuery] = useState("");
  const surfaces = props.surfaces.filter((surface) =>
    `${props.title(surface)} ${surface.kind === "file" ? surface.relativePath : ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <CommandDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setQuery("");
        props.onOpenChange(open);
      }}
    >
      <CommandDialogPopup aria-label="Switch panel tab">
        <Command mode="none" value={query} onValueChange={setQuery}>
          <CommandInput aria-label="Search panel tabs" placeholder="Search panel tabs…" />
          <CommandEmpty>No matching tabs.</CommandEmpty>
          <CommandList>
            {surfaces.map((surface, index) => (
              <CommandItem
                key={surface.id}
                index={index}
                value={surface.id}
                onClick={() => {
                  props.onActivate(surface);
                  props.onOpenChange(false);
                  setQuery("");
                }}
              >
                <span className="truncate">
                  {surface.kind === "file" ? surface.relativePath : props.title(surface)}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
