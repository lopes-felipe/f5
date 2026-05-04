import { type ProviderKind } from "@t3tools/contracts";
import { memo } from "react";
import { StarIcon } from "lucide-react";
import { ComboboxItem } from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  getDisplayModelName,
  getProviderLabel,
  getTriggerDisplayModelLabel,
  type ModelPickerModelOption,
  providerIconClassName,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelPickerModelOption;
  providerKind: ProviderKind;
  isFavorite: boolean;
  isSelected: boolean;
  showProvider: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  jumpLabel?: string | null;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.providerKind];
  const favoriteLabel = props.isFavorite ? "Remove from favorites" : "Add to favorites";

  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.providerKind}:${props.model.slug}`}
      disabled={props.disabled}
      contentClassName="flex w-full items-start gap-2"
      className={cn(
        "w-full rounded px-3 py-2 transition-colors group",
        props.disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer",
        "data-highlighted:bg-muted data-selected:bg-accent data-selected:text-foreground",
      )}
      aria-label={
        props.disabled && props.disabledReason
          ? `${props.model.name}. ${props.disabledReason}`
          : props.model.name
      }
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className={cn(
                "mt-0.5 shrink-0 cursor-pointer rounded-sm opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                props.isFavorite && "opacity-100",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onToggleFavorite();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              type="button"
              aria-label={favoriteLabel}
            >
              <StarIcon
                className={cn("size-4", props.isFavorite && "fill-current text-yellow-500")}
              />
            </button>
          }
        />
        <TooltipPopup side="top" align="center">
          {favoriteLabel}
        </TooltipPopup>
      </Tooltip>

      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium leading-snug">
            <span className="truncate">
              {props.useTriggerLabel
                ? getTriggerDisplayModelLabel(props.model)
                : getDisplayModelName(
                    props.model,
                    props.preferShortName ? { preferShortName: true } : undefined,
                  )}
            </span>
            {props.isSelected ? (
              <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1 py-px text-[10px] font-medium uppercase leading-none text-primary">
                Active
              </span>
            ) : null}
          </div>
          {props.jumpLabel ? (
            <Kbd className="h-4 min-w-0 shrink-0 rounded-sm px-1.5 text-[10px]">
              {props.jumpLabel}
            </Kbd>
          ) : null}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs font-normal leading-snug text-muted-foreground/70">
          {props.showProvider ? (
            <>
              <ProviderIcon
                className={cn("size-3 shrink-0", providerIconClassName(props.providerKind))}
              />
              <span className="truncate">{getProviderLabel(props.providerKind, props.model)}</span>
            </>
          ) : (
            <span className="truncate">{props.model.slug}</span>
          )}
          {props.disabled && props.disabledReason ? (
            <span className="min-w-0 truncate">· {props.disabledReason}</span>
          ) : null}
        </div>
      </div>
    </ComboboxItem>
  );
});
