import { RUNTIME_MODE_VALUES, type ProviderKind, type RuntimeMode } from "@t3tools/contracts";
import { runtimeModeCapabilities, runtimeModeUnsupportedReason } from "@t3tools/shared/runtimeMode";

import { Button } from "../ui/button";
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
        render={
          <Button
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
            size="sm"
            type="button"
            disabled={props.disabled}
            title={`${presentation.label} — ${presentation.description}`}
          />
        }
      >
        <Icon />
        <span className="sr-only sm:not-sr-only">{presentation.label}</span>
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
