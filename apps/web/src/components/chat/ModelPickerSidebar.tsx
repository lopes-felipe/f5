import { type ProviderKind, type ServerProviderStatus } from "@t3tools/contracts";
import { memo } from "react";
import { Clock3Icon, StarIcon } from "lucide-react";
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

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  selectedProvider: ProviderKind | "favorites";
  providers?: ReadonlyArray<ServerProviderStatus> | undefined;
  onSelectProvider: (provider: ProviderKind | "favorites") => void;
}) {
  return (
    <div className="flex w-12 flex-col gap-1 overflow-y-auto border-r bg-muted/30 p-1">
      <div className="mb-1 border-b pb-1">
        <div className="relative w-full">
          {props.selectedProvider === "favorites" ? (
            <div className={SELECTED_INDICATOR_CLASS} />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  className={cn(
                    "relative isolate flex aspect-square w-full cursor-pointer items-center justify-center rounded transition-colors hover:bg-muted",
                    props.selectedProvider === "favorites" && SELECTED_BUTTON_CLASS,
                  )}
                  onClick={() => props.onSelectProvider("favorites")}
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

      {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
        const OptionIcon = PROVIDER_ICON_BY_PICKER_KIND[option.value];
        const status = findProviderStatus(props.providers, option.value);
        const isSelectable = isProviderSelectable(status);
        const isSelected = props.selectedProvider === option.value;
        const tooltip = describeProviderStatus(option.label, status);

        const button = (
          <button
            data-model-picker-provider={option.value}
            className={cn(
              "relative isolate flex aspect-square w-full items-center justify-center rounded transition-colors",
              isSelectable
                ? "cursor-pointer hover:bg-muted"
                : "cursor-not-allowed opacity-50 hover:bg-transparent",
              isSelected && SELECTED_BUTTON_CLASS,
            )}
            onClick={() => {
              if (isSelectable) {
                props.onSelectProvider(option.value);
              }
            }}
            disabled={!isSelectable}
            type="button"
            aria-label={tooltip}
          >
            <OptionIcon
              className={cn("size-5 shrink-0", providerIconClassName(option.value))}
              aria-hidden
            />
          </button>
        );

        return (
          <div key={option.value} className="relative w-full">
            {isSelected ? <div className={SELECTED_INDICATOR_CLASS} /> : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  isSelectable ? button : <span className="relative block w-full">{button}</span>
                }
              />
              <TooltipPopup side="left" align="center" className="max-w-64 leading-snug">
                {tooltip}
              </TooltipPopup>
            </Tooltip>
          </div>
        );
      })}

      {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
        const OptionIcon = PROVIDER_ICON_BY_PICKER_KIND[option.value];
        return (
          <Tooltip key={option.value}>
            <TooltipTrigger
              render={
                <span className="relative block w-full">
                  <button
                    className="relative isolate flex aspect-square w-full cursor-not-allowed items-center justify-center rounded opacity-50"
                    disabled
                    type="button"
                    data-model-picker-provider={`${option.value}-unavailable`}
                    aria-label={`${option.label} · coming soon`}
                  >
                    <OptionIcon
                      className={cn(
                        "size-5 text-muted-foreground/85",
                        providerIconClassName(option.value),
                      )}
                      aria-hidden
                    />
                    <span className={SOON_BADGE_CLASS} aria-hidden>
                      <Clock3Icon className="size-2" />
                    </span>
                  </button>
                </span>
              }
            />
            <TooltipPopup side="left" align="center" className="max-w-64 leading-snug">
              {option.label} · Coming soon
            </TooltipPopup>
          </Tooltip>
        );
      })}

      {COMING_SOON_PROVIDER_OPTIONS.map((option) => {
        const OptionIcon = option.icon;
        return (
          <Tooltip key={option.id}>
            <TooltipTrigger
              render={
                <span className="relative block w-full">
                  <button
                    className="relative isolate flex aspect-square w-full cursor-not-allowed items-center justify-center rounded opacity-50"
                    disabled
                    type="button"
                    data-model-picker-provider={`${option.id}-coming-soon`}
                    aria-label={`${option.label} · coming soon`}
                  >
                    <OptionIcon className="size-5 text-muted-foreground/85" aria-hidden />
                    <span className={SOON_BADGE_CLASS} aria-hidden>
                      <Clock3Icon className="size-2" />
                    </span>
                  </button>
                </span>
              }
            />
            <TooltipPopup side="left" align="center" className="max-w-64 leading-snug">
              {option.label} · Coming soon
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
});
