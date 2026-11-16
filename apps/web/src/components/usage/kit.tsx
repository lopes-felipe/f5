/**
 * The Usage page's design kit: every surface on the page is built from these
 * parts or from `ui/*` primitives, so Activity, Limits and Pricing share one
 * container, stat tile, table, toggle and note style.
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsUpDownIcon,
  InfoIcon,
  MinusIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SectionLabel } from "../ui/section-label";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Cell classes shared by every Usage table, including compact ones. */
export const usageTableClasses = {
  table: "w-full text-left text-xs",
  head: "border-y border-border/70 bg-muted/20 text-muted-foreground",
  headCell: "px-4 py-2 font-medium",
  row: "border-b border-border/50 last:border-b-0",
  cell: "px-4 py-2.5",
  numeric: "text-right tabular-nums",
  compactHeadCell: "py-1 pr-3 font-medium",
  compactCell: "py-1 pr-3",
  compactRow: "border-t border-border/50",
} as const;

/** A short explanation behind an info icon, for context that would clutter a title. */
export function InfoTip(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.label}
            className="text-muted-foreground"
          />
        }
      >
        <InfoIcon aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72 text-xs">
        {props.children}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The one container for every block on the Usage page. */
export function UsageSection(props: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Shown behind an info icon beside the title. */
  readonly info?: ReactNode;
  readonly infoLabel?: string;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  /** Tables run edge to edge. */
  readonly flush?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly panelClassName?: string;
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
}) {
  const label = props["aria-label"] ?? (typeof props.title === "string" ? props.title : undefined);
  return (
    <Card
      render={<section id={props.id} aria-label={label} />}
      className={cn("scroll-mt-4 rounded-xl", props.className)}
    >
      <CardHeader className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-4 pb-3">
        <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <CardTitle render={<h2 />} className="text-sm leading-6 font-semibold">
              {props.title}
            </CardTitle>
            {props.info ? (
              <InfoTip
                label={
                  props.infoLabel ??
                  `About ${typeof props.title === "string" ? props.title : "this section"}`
                }
              >
                {props.info}
              </InfoTip>
            ) : null}
            {props.meta ? (
              <span className="text-2xs text-muted-foreground">{props.meta}</span>
            ) : null}
          </div>
          {props.description ? (
            <CardDescription className="text-xs">{props.description}</CardDescription>
          ) : null}
        </div>
        {props.actions ? (
          <CardAction className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2">
            {props.actions}
          </CardAction>
        ) : null}
      </CardHeader>
      {props.children !== undefined ? (
        <CardPanel
          className={cn(props.flush ? "overflow-x-auto p-0" : "p-4 pt-0", props.panelClassName)}
        >
          {props.children}
        </CardPanel>
      ) : null}
    </Card>
  );
}

/** A group inside a section, separated by a hairline. */
export function UsageSubsection(props: {
  readonly label: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly first?: boolean;
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const label = props["aria-label"] ?? (typeof props.label === "string" ? props.label : undefined);
  return (
    <section
      aria-label={label}
      className={cn("space-y-3", !props.first && "border-t border-border/60 pt-3", props.className)}
    >
      <SectionLabel
        as="h3"
        trailing={
          props.meta || props.actions ? (
            <div className="ml-auto flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
              {props.meta}
              {props.actions}
            </div>
          ) : undefined
        }
      >
        {props.label}
      </SectionLabel>
      {props.children}
    </section>
  );
}

export type DeltaDirection = "up" | "down" | "flat";

/** "+23% vs previous 7 days" → up; "−8% …" → down; anything else → flat. */
export function deltaDirection(text: string): DeltaDirection {
  if (text.startsWith("+") || text.startsWith("New")) return "up";
  if (text.startsWith("−") || text.startsWith("-")) return "down";
  return "flat";
}

/** Neutral change badge: a rise isn't inherently good or bad. */
export function DeltaBadge(props: { readonly text: string }) {
  const direction = deltaDirection(props.text);
  const Icon = direction === "up" ? ArrowUpIcon : direction === "down" ? ArrowDownIcon : MinusIcon;
  return (
    <Badge size="sm" variant="secondary" className="gap-0.5 tabular-nums" title={props.text}>
      <Icon aria-hidden="true" className="size-3" />
      <span>{props.text}</span>
    </Badge>
  );
}

/** One stat. `card` stands alone; `inset` sits inside a section. */
export function StatTile(props: {
  readonly label: string;
  readonly value: string;
  readonly icon?: LucideIcon;
  readonly detail?: ReactNode;
  readonly delta?: string | null;
  readonly variant?: "card" | "inset";
}) {
  const Icon = props.icon;
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        {Icon ? <Icon aria-hidden="true" className="size-3.5" /> : null}
        {props.label}
      </div>
      <div
        className={cn(
          "font-semibold tracking-tight text-foreground tabular-nums",
          props.variant === "inset" ? "mt-0.5 text-lg" : "mt-2 text-2xl",
        )}
      >
        {props.value}
      </div>
      {props.detail ? <p className="mt-1 text-2xs text-muted-foreground">{props.detail}</p> : null}
      {props.delta ? (
        <div className="mt-1.5">
          <DeltaBadge text={props.delta} />
        </div>
      ) : null}
    </>
  );
  if (props.variant === "inset")
    return <div className="rounded-lg bg-muted/30 px-3 py-2">{body}</div>;
  return (
    <Card className="rounded-xl">
      <CardPanel className="p-4">{body}</CardPanel>
    </Card>
  );
}

/** Segmented single-choice control on the shared ToggleGroup. */
export function UsageToggle<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{
    readonly value: Value;
    readonly label: string;
    readonly disabled?: boolean;
  }>;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <ToggleGroup
      aria-label={props.label}
      variant="outline"
      size="xs"
      value={[props.value]}
      onValueChange={(next) => {
        const selected = next[0] as Value | undefined;
        if (selected && selected !== props.value) props.onChange(selected);
      }}
    >
      {props.options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className="px-2 text-xs"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export type UsageSortDirection = "asc" | "desc";
export interface UsageSort {
  readonly key: string;
  readonly direction: UsageSortDirection;
}

export interface UsageColumn<Row> {
  readonly key: string;
  readonly header: ReactNode;
  /** Plain-text header for sort button labels when `header` isn't a string. */
  readonly headerLabel?: string;
  readonly headerTitle?: string;
  readonly align?: "left" | "right";
  readonly sortValue?: (row: Row) => number | string;
  readonly render: (row: Row) => ReactNode;
  readonly className?: string;
}

/** Orders rows by `sort`, keeping `pinLast` rows at the end; null keeps the given order. */
export function sortUsageRows<Row>(
  rows: ReadonlyArray<Row>,
  columns: ReadonlyArray<UsageColumn<Row>>,
  sort: UsageSort | null,
  pinLast?: (row: Row) => boolean,
): Array<Row> {
  const column = sort ? columns.find((entry) => entry.key === sort.key) : undefined;
  const sortValue = column?.sortValue;
  if (!sort || !sortValue) return [...rows];
  const factor = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const pinned = Number(pinLast?.(left.row) ?? false) - Number(pinLast?.(right.row) ?? false);
      if (pinned !== 0) return pinned;
      const a = sortValue(left.row);
      const b = sortValue(right.row);
      const order =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
      return order * factor || left.index - right.index;
    })
    .map((entry) => entry.row);
}

/** Clicking a header sorts descending first, then toggles direction. */
export function nextUsageSort(current: UsageSort | null, key: string): UsageSort {
  if (current?.key !== key) return { key, direction: "desc" };
  return { key, direction: current.direction === "desc" ? "asc" : "desc" };
}

export function UsageTable<Row>(props: {
  readonly caption?: string;
  readonly columns: ReadonlyArray<UsageColumn<Row>>;
  readonly rows: ReadonlyArray<Row>;
  readonly rowKey: (row: Row) => string;
  readonly rowClassName?: (row: Row) => string | false | undefined;
  readonly sort?: UsageSort | null;
  readonly onSortChange?: (sort: UsageSort) => void;
  readonly pinLast?: (row: Row) => boolean;
  readonly empty: ReactNode;
  readonly footer?: ReactNode;
  readonly minWidth?: boolean;
}) {
  const sort = props.sort ?? null;
  const rows = sortUsageRows(props.rows, props.columns, sort, props.pinLast);
  return (
    <>
      {rows.length === 0 ? (
        <div className="border-t border-border/70 p-4 text-sm text-muted-foreground">
          {props.empty}
        </div>
      ) : (
        <table className={cn(usageTableClasses.table, props.minWidth !== false && "min-w-[640px]")}>
          {props.caption ? <caption className="sr-only">{props.caption}</caption> : null}
          <thead className={usageTableClasses.head}>
            <tr>
              {props.columns.map((column) => {
                const right = column.align === "right";
                const active = sort?.key === column.key ? sort.direction : null;
                const sortable = column.sortValue !== undefined && props.onSortChange;
                const SortIcon =
                  active === "asc"
                    ? ChevronUpIcon
                    : active === "desc"
                      ? ChevronDownIcon
                      : ChevronsUpDownIcon;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    title={column.headerTitle}
                    aria-sort={
                      sortable
                        ? active === "asc"
                          ? "ascending"
                          : active === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                    className={cn(usageTableClasses.headCell, right && "text-right")}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className={cn(
                          "group inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          right && "flex-row-reverse",
                          active && "text-foreground",
                        )}
                        aria-label={`Sort by ${column.headerLabel ?? (typeof column.header === "string" ? column.header : column.key)}`}
                        onClick={() => props.onSortChange?.(nextUsageSort(sort, column.key))}
                      >
                        {column.header}
                        <SortIcon
                          aria-hidden="true"
                          className={cn(
                            "size-3",
                            active ? "opacity-80" : "opacity-0 group-hover:opacity-60",
                          )}
                        />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={props.rowKey(row)}
                className={cn(usageTableClasses.row, props.rowClassName?.(row))}
              >
                {props.columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      usageTableClasses.cell,
                      column.align === "right" && usageTableClasses.numeric,
                      column.className,
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.footer}
    </>
  );
}

/** Collapsed notes at the bottom of a tab: caveats that would otherwise repeat everywhere. */
export function AboutTheseNumbers(props: { readonly notes: ReadonlyArray<ReactNode> }) {
  const [open, setOpen] = useState(false);
  const notes = props.notes.filter(Boolean);
  if (notes.length === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border border-dashed border-border px-4 py-2.5"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        About these numbers
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** A used-share bar with an optional pace tick, matching the quota meters. */
export function UsageBar(props: {
  readonly percent: number;
  readonly tickPercent?: number | null;
  readonly tone?: "default" | "warning" | "error";
  readonly className?: string;
}) {
  const percent = Math.min(100, Math.max(0, props.percent));
  return (
    <div aria-hidden="true" className={cn("relative h-2 rounded-full bg-muted", props.className)}>
      <div
        className={cn(
          "absolute inset-y-0 left-0 rounded-full transition-[width]",
          props.tone === "error"
            ? "bg-destructive"
            : props.tone === "warning"
              ? "bg-warning"
              : "bg-primary",
        )}
        style={{ width: `${percent}%` }}
      />
      {props.tickPercent !== null && props.tickPercent !== undefined ? (
        <div
          className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${Math.min(100, Math.max(0, props.tickPercent))}%` }}
        />
      ) : null}
    </div>
  );
}
