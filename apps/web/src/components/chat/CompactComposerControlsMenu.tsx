import { ProviderInteractionMode, RuntimeMode, type ProviderKind } from "@t3tools/contracts";
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
import { RuntimeModeMenuItems } from "./RuntimeModePicker";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  canCompactConversation?: boolean;
  compactConversationDisabled?: boolean;
  disabled?: boolean;
  interactionMode: ProviderInteractionMode;
  showInteractionModeToggle?: boolean;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  provider: ProviderKind;
  traitsMenuContent?: ReactNode;
  onCompactConversation?: () => void;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (value: RuntimeMode) => void;
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
        {props.showInteractionModeToggle !== false ? (
          <>
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
          </>
        ) : null}
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <RuntimeModeMenuItems
            disabled={props.disabled}
            provider={props.provider}
            value={props.runtimeMode}
            onValueChange={props.onRuntimeModeChange}
          />
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
