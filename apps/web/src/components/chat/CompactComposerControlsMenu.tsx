import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { BotIcon, EllipsisIcon, ListTodoIcon, NotebookPenIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  canCompactConversation?: boolean;
  compactConversationDisabled?: boolean;
  disabled?: boolean;
  interactionMode: ProviderInteractionMode;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  onCompactConversation?: () => void;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onToggleRuntimeMode: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
            disabled={props.disabled}
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
          <MenuRadioGroup
            value={props.interactionMode}
            onValueChange={(value) => {
              if (props.disabled) return;
              if (!value || value === props.interactionMode) return;
              props.onToggleInteractionMode();
            }}
          >
            <MenuRadioItem value="default">
              <BotIcon className="size-4 shrink-0" />
              Chat
            </MenuRadioItem>
            <MenuRadioItem value="plan">
              <NotebookPenIcon className="size-4 shrink-0" />
              Plan
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        <MenuDivider />
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (props.disabled) return;
              if (!value || value === props.runtimeMode) return;
              props.onToggleRuntimeMode();
            }}
          >
            <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
            <MenuRadioItem value="full-access">Full access</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {props.canCompactConversation ? (
          <>
            <MenuDivider />
            <MenuItem
              onClick={props.onCompactConversation}
              disabled={props.disabled || props.compactConversationDisabled}
            >
              Compact conversation
            </MenuItem>
          </>
        ) : null}
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar} disabled={props.disabled}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
