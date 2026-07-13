import { type ProviderKind, type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { Clock3Icon, StarIcon } from "lucide-react";
import type { Icon } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  COMING_SOON_PROVIDER_OPTIONS,
  describeProviderStatus,
  findProviderStatus,
  isProviderSelectable,
  providerIconClassName,
  PROVIDER_ICON_BY_PICKER_KIND,
  UNAVAILABLE_PROVIDER_OPTIONS,
} from "./providerIconUtils";

const SELECTED_BUTTON_CLASS = "bg-background text-foreground shadow-sm";
const SELECTED_INDICATOR_CLASS =
  "pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.5 -translate-y-1/2 rounded-l-full bg-primary";
const SOON_BADGE_CLASS =
  "pointer-events-none absolute -right-0.5 top-0.5 z-10 flex size-3.5 items-center justify-center rounded-full bg-transparent text-muted-foreground shadow-sm";

export interface ModelPickerSidebarRailItem {
  readonly id: string;
  readonly label: string;
  readonly icon: Icon;
  readonly iconClassName?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly comingSoon?: boolean | undefined;
  readonly isCustom?: boolean | undefined;
  readonly accentColor?: string | undefined;
}

/**
 * Shared visual rail for the legacy provider picker and the instance-aware
 * picker. Keeping the presentation here preserves the compact provider
 * sidebar while letting callers own their routing keys and availability
 * rules.
 */
export const ModelPickerSidebarRail = memo(function ModelPickerSidebarRail(props: {
  selectedId: string | "favorites";
  items: ReadonlyArray<ModelPickerSidebarRailItem>;
  onSelect: (id: string | "favorites") => void;
}) {
  return (
    <div className="flex w-12 flex-col gap-1 overflow-y-auto border-r bg-muted/30 p-1">
      <div className="mb-1 border-b pb-1">
        <div className="relative w-full">
          {props.selectedId === "favorites" ? <div className={SELECTED_INDICATOR_CLASS} /> : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  className={cn(
                    "relative isolate flex aspect-square w-full cursor-pointer items-center justify-center rounded transition-colors hover:bg-muted",
                    props.selectedId === "favorites" && SELECTED_BUTTON_CLASS,
                  )}
                  onClick={() => props.onSelect("favorites")}
                  type="button"
                  data-model-picker-provider="favorites"
                  aria-label="Favorites"
                >
                  <StarIcon className="size-5 shrink-0 fill-current" aria-hidden />
                </button>
              }
            />
            <TooltipPopup side="left" align="center" className="max-w-64 leading-snug">
              Favorites
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {props.items.map((item) => {
        const ItemIcon = item.icon;
        const isSelected = props.selectedId === item.id;
        const button = (
          <button
            data-model-picker-provider={item.id}
            className={cn(
              "relative isolate flex aspect-square w-full items-center justify-center rounded transition-colors",
              item.disabled
                ? "cursor-not-allowed opacity-50 hover:bg-transparent"
                : "cursor-pointer hover:bg-muted",
              isSelected && SELECTED_BUTTON_CLASS,
            )}
            onClick={() => {
              if (!item.disabled) props.onSelect(item.id);
            }}
            disabled={item.disabled}
            type="button"
            aria-label={item.label}
          >
            <ItemIcon className={cn("size-5 shrink-0", item.iconClassName)} aria-hidden />
            {item.comingSoon ? (
              <span className={SOON_BADGE_CLASS} aria-hidden>
                <Clock3Icon className="size-2" />
              </span>
            ) : item.isCustom ? (
              <span
                className="pointer-events-none absolute right-1 bottom-1 size-1.5 rounded-full border border-background bg-foreground/50"
                style={item.accentColor ? { backgroundColor: item.accentColor } : undefined}
                aria-hidden
              />
            ) : null}
          </button>
        );

        return (
          <div key={item.id} className="relative w-full">
            {isSelected ? <div className={SELECTED_INDICATOR_CLASS} /> : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  item.disabled ? <span className="relative block w-full">{button}</span> : button
                }
              />
              <TooltipPopup side="left" align="center" className="max-w-64 leading-snug">
                {item.label}
              </TooltipPopup>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
});

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedProvider: ProviderKind | "favorites";
  providers?: ReadonlyArray<ServerProvider> | undefined;
  onSelectProvider: (provider: ProviderKind | "favorites") => void;
}) {
  const items: ModelPickerSidebarRailItem[] = [
    ...AVAILABLE_PROVIDER_OPTIONS.map((option) => {
      const status = findProviderStatus(props.providers, option.value);
      return {
        id: option.value,
        label: describeProviderStatus(option.label, status),
        icon: PROVIDER_ICON_BY_PICKER_KIND[option.value],
        iconClassName: providerIconClassName(option.value),
        disabled: !isProviderSelectable(status),
      } satisfies ModelPickerSidebarRailItem;
    }),
    ...UNAVAILABLE_PROVIDER_OPTIONS.map(
      (option) =>
        ({
          id: `${option.value}-unavailable`,
          label: `${option.label} · Coming soon`,
          icon: PROVIDER_ICON_BY_PICKER_KIND[option.value],
          iconClassName: cn("text-muted-foreground/85", providerIconClassName(option.value)),
          disabled: true,
          comingSoon: true,
        }) satisfies ModelPickerSidebarRailItem,
    ),
    ...COMING_SOON_PROVIDER_OPTIONS.map(
      (option) =>
        ({
          id: `${option.id}-coming-soon`,
          label: `${option.label} · Coming soon`,
          icon: option.icon,
          iconClassName: "text-muted-foreground/85",
          disabled: true,
          comingSoon: true,
        }) satisfies ModelPickerSidebarRailItem,
    ),
  ];

  return (
    <ModelPickerSidebarRail
      selectedId={props.selectedProvider}
      items={items}
      onSelect={(id) => props.onSelectProvider(id as ProviderKind | "favorites")}
    />
  );
});
