import { memo } from "react";
import { EllipsisIcon, QuoteIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

/** Secondary actions for a settled assistant message; Copy sits inline beside it. */
export const AssistantMessageActions = memo(function AssistantMessageActions({
  onQuote,
}: {
  onQuote: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            title="Message actions"
            aria-label="Message actions"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end">
        <MenuItem onClick={onQuote}>
          <QuoteIcon />
          Quote in reply
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});
