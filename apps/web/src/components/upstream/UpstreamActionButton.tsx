import type { KeybindingCommand } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";

import { shortcutLabelForCommand, useServerKeybindings } from "../../keybindings";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The shortcut label for an Upstream command, or `null` when it is unbound. */
export function useUpstreamShortcut(command: KeybindingCommand | null): string | null {
  const keybindings = useServerKeybindings();
  return shortcutLabelForCommand(keybindings, command);
}

/**
 * A button whose tooltip names the action and its shortcut. A disabled button
 * gets no pointer events, so the tooltip anchors on a wrapper.
 */
export function UpstreamActionButton(
  props: Omit<ComponentProps<typeof Button>, "children"> & {
    readonly label: string;
    readonly command?: KeybindingCommand | null;
    readonly tooltip?: ReactNode;
    readonly children?: ReactNode;
  },
) {
  const { label, command = null, tooltip, children, ...buttonProps } = props;
  const shortcut = useUpstreamShortcut(command);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button aria-label={children ? undefined : label} {...buttonProps}>
          {children ?? label}
        </Button>
      </TooltipTrigger>
      <TooltipPopup>
        <span className="flex items-center gap-2">
          {tooltip ?? label}
          {shortcut && <Kbd>{shortcut}</Kbd>}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
