import { WorkflowIcon } from "lucide-react";

import { FastModeTriggerIcon } from "./EffortMenuSection";

/** Icons for the switched-on booleans in a traits chip; see `traitsTriggerParts`. */
export function TraitsTriggerIcons(props: {
  readonly icons: ReadonlyArray<"fastMode" | "ultracode">;
}) {
  return props.icons.map((icon) =>
    icon === "fastMode" ? (
      <span key={icon} title="Fast mode on" className="inline-flex">
        <FastModeTriggerIcon />
      </span>
    ) : (
      <span key={icon} title="Ultracode on" className="inline-flex">
        <WorkflowIcon className="size-3 shrink-0" aria-label="Ultracode on" />
      </span>
    ),
  );
}
