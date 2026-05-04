import {
  type ModelSlug,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ServerProviderStatus,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent } from "./ModelPickerContent";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
  type ModelPickerModelOption,
  providerIconClassName,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";

export { AVAILABLE_PROVIDER_OPTIONS };
export type { ModelPickerModelOption };

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus> | undefined;
  keybindings?: ResolvedKeybindingsConfig | undefined;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ModelPickerModelOption>>;
  ultrathinkActive?: boolean;
  compact?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"] | undefined;
  triggerClassName?: string | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = props.open ?? uncontrolledOpen;
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModel =
    selectedProviderOptions.find((option) => option.slug === props.model) ??
    ({
      slug: props.model,
      name: props.model,
    } satisfies ModelPickerModelOption);
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const triggerTitle = getTriggerDisplayModelName(selectedModel);
  const triggerSubtitle = selectedModel.subProvider;
  const triggerLabel = getTriggerDisplayModelLabel(selectedModel);

  const setOpen = useCallback(
    (open: boolean) => {
      props.onOpenChange?.(open);
      if (props.open === undefined) {
        setUncontrolledOpen(open);
      }
    },
    [props.onOpenChange, props.open],
  );

  useEffect(() => {
    if (props.disabled && isOpen) {
      setOpen(false);
    }
  }, [isOpen, props.disabled, setOpen]);

  const handleProviderModelChange = (provider: ProviderKind, model: ModelSlug) => {
    if (props.disabled) return;
    props.onProviderModelChange(provider, model);
    setOpen(false);
  };

  return (
    <Popover
      open={isOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setOpen(false);
          return;
        }
        setOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full items-center gap-2 overflow-hidden",
            props.compact ? "max-w-36 sm:pl-1" : undefined,
          )}
        >
          <ProviderIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0",
              providerIconClassName(activeProvider),
              activeProvider === "claudeAgent" && props.ultrathinkActive
                ? "ultrathink-chroma"
                : undefined,
            )}
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "min-w-0 flex-1 overflow-hidden",
                    triggerSubtitle
                      ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1"
                      : "truncate",
                  )}
                />
              }
            >
              {triggerSubtitle ? (
                <>
                  <span className="min-w-0 truncate">{triggerSubtitle}</span>
                  <span aria-hidden="true" className="shrink-0 opacity-60">
                    ·
                  </span>
                  <span className="min-w-0 truncate">{triggerTitle}</span>
                </>
              ) : (
                triggerTitle
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
          </Tooltip>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
      >
        <ModelPickerContent
          provider={props.provider}
          model={props.model}
          lockedProvider={props.lockedProvider}
          providers={props.providers}
          keybindings={props.keybindings}
          modelOptionsByProvider={props.modelOptionsByProvider}
          terminalOpen={props.terminalOpen ?? false}
          onRequestClose={() => setOpen(false)}
          onProviderModelChange={handleProviderModelChange}
        />
      </PopoverPopup>
    </Popover>
  );
});
