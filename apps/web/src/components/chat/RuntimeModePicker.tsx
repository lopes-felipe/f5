import { RUNTIME_MODE_VALUES, type ProviderKind, type RuntimeMode } from "@t3tools/contracts";
import { runtimeModeCapabilities, runtimeModeUnsupportedReason } from "@t3tools/shared/runtimeMode";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { COMPOSER_CHIP_CLASS_NAME } from "./composer/composerChip";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { RUNTIME_MODE_PRESENTATION } from "./runtimeModePresentation";

export function RuntimeModeMenuItems(props: {
  readonly disabled?: boolean | undefined;
  readonly provider: ProviderKind;
  readonly value: RuntimeMode;
  readonly onValueChange: (value: RuntimeMode) => void;
}) {
  const capabilities = runtimeModeCapabilities(props.provider);
  return (
    <MenuRadioGroup
      value={props.value}
      onValueChange={(value) => {
        if (!value || props.disabled || value === props.value) return;
        const runtimeMode = value as RuntimeMode;
        if (!capabilities.has(runtimeMode)) return;
        props.onValueChange(runtimeMode);
      }}
    >
      {RUNTIME_MODE_VALUES.map((runtimeMode) => {
        const presentation = RUNTIME_MODE_PRESENTATION[runtimeMode];
        const Icon = presentation.icon;
        const unsupportedReason = runtimeModeUnsupportedReason(props.provider, runtimeMode);
        return (
          <MenuRadioItem
            key={runtimeMode}
            value={runtimeMode}
            disabled={props.disabled || unsupportedReason !== undefined}
            title={unsupportedReason}
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0">
              <span className="block">{presentation.label}</span>
              <span className="block text-muted-foreground text-xs">
                {unsupportedReason ?? presentation.description}
              </span>
            </span>
          </MenuRadioItem>
        );
      })}
    </MenuRadioGroup>
  );
}

export function RuntimeModePicker(props: {
  readonly disabled?: boolean | undefined;
  readonly provider: ProviderKind;
  readonly value: RuntimeMode;
  readonly onValueChange: (value: RuntimeMode) => void;
}) {
  const presentation = RUNTIME_MODE_PRESENTATION[props.value];
  const Icon = presentation.icon;
  return (
    <Menu>
      <MenuTrigger
        data-composer-control="runtimeMode"
        render={
          <Button
            variant="ghost"
            className={cn(
              COMPOSER_CHIP_CLASS_NAME,
              props.value === "full-access" &&
                "text-warning-foreground hover:text-warning-foreground data-popup-open:text-warning-foreground",
            )}
            size="sm"
            type="button"
            disabled={props.disabled}
            title={`${presentation.label} — ${presentation.description}`}
          />
        }
      >
        <Icon />
        <span className="sr-only @lg/composer-footer:not-sr-only">{presentation.label}</span>
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        <MenuGroup>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <RuntimeModeMenuItems {...props} />
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
