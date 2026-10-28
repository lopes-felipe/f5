import type {
  UpstreamDecidedBy,
  UpstreamStateCounts,
  UpstreamSuggestionFilter,
  UpstreamTopicFacets,
  UpstreamTopicList,
  UpstreamTopicSort,
  UpstreamUserImpact,
} from "@t3tools/contracts";
import { ArrowUpDownIcon, BotIcon, HelpCircleIcon, ListFilterIcon, PlayIcon, SearchIcon, XIcon } from "lucide-react";
import { forwardRef, useEffect, useRef, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { useUpstreamShortcut } from "./UpstreamActionButton";
import {
  activeFilterChips,
  DECIDED_BY_LABELS,
  IMPACT_LABELS,
  SORT_LABELS,
  SUGGESTION_FILTER_LABELS,
  toggleValue,
  UPSTREAM_LISTS,
  withoutFilters,
} from "./upstreamPage.logic";
import type { UpstreamSearch } from "./upstreamSearch";

const SEARCH_DEBOUNCE_MS = 200;
const SUGGESTIONS: ReadonlyArray<UpstreamSuggestionFilter> = ["port", "skip", "watch", "equivalent", "none"];
const IMPACTS: ReadonlyArray<UpstreamUserImpact> = ["high", "medium", "low", "none"];
const DECIDED_BY: ReadonlyArray<UpstreamDecidedBy> = ["user", "llm", "rule"];
const SORTS: ReadonlyArray<UpstreamTopicSort> = ["priority", "newest", "oldest", "confidence"];

const count = (value: number | undefined) =>
  value === undefined ? null : <span className="ms-auto ps-3 text-muted-foreground tabular-nums">{value}</span>;

/** The search box. It pushes its text to the URL after a short pause; `Esc` returns to the list. */
const SearchBox = forwardRef<
  HTMLInputElement,
  {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly onEscape: () => void;
  }
>(function SearchBox(props, ref) {
  const focusShortcut = useUpstreamShortcut("upstream.focusSearch");
  const [text, setText] = useState(props.value);
  const pushed = useRef(props.value);
  // Follow outside changes, such as Clear filters, without clobbering what the user is typing.
  useEffect(() => {
    if (props.value !== pushed.current) {
      pushed.current = props.value;
      setText(props.value);
    }
  }, [props.value]);
  // Through a ref: the parent passes a new closure each render, which must not restart the debounce.
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onChange = (value: string) => onChangeRef.current(value);
  useEffect(() => {
    if (text === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = text;
      onChangeRef.current(text);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className="relative w-56">
      <SearchIcon className="pointer-events-none absolute start-2 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={ref}
        size="sm"
        type="search"
        aria-label="Search topics"
        placeholder="Search topics"
        className="[&_input]:ps-6"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onEscape();
          } else if (event.key === "Enter" && text !== pushed.current) {
            pushed.current = text;
            onChange(text);
          }
        }}
      />
      {focusShortcut && !text && (
        <Kbd className="pointer-events-none absolute end-1.5 top-1/2 -translate-y-1/2">{focusShortcut}</Kbd>
      )}
    </div>
  );
});

export const UpstreamToolbar = forwardRef<
  HTMLInputElement,
  {
    readonly list: UpstreamTopicList;
    readonly counts: UpstreamStateCounts;
    readonly onListChange: (list: UpstreamTopicList) => void;
    readonly search: UpstreamSearch;
    /** Applies new filter or sort params; the page keeps the project and list. */
    readonly onSearchChange: (search: UpstreamSearch) => void;
    readonly facets: UpstreamTopicFacets | null;
    readonly onSearchEscape: () => void;
    /** Ready list: Start port for every Ready topic. */
    readonly startAll: {
      readonly count: number;
      readonly disabled: boolean;
      readonly onStart: () => void;
    } | null;
  }
>(function UpstreamToolbar(props, searchRef) {
  const { search, facets, onSearchChange } = props;
  const chips = activeFilterChips(search);
  const sort = search.sort ?? (props.list === "inbox" ? "priority" : "newest");
  /** Merges `patch` into the search params; `undefined` or an empty list removes a key. */
  const set = (patch: {
    readonly [Key in keyof UpstreamSearch]?: UpstreamSearch[Key] | undefined;
  }) => {
    const next: Record<string, unknown> = { ...search, ...patch };
    for (const [key, value] of Object.entries(patch))
      if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key];
    onSearchChange(next as UpstreamSearch);
  };
  const strip = props.list === "inbox" && facets ? SUGGESTIONS.filter((value) => facets.suggestion[value] > 0) : [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Topic lists"
          size="sm"
          value={[props.list]}
          onValueChange={(values) => {
            const next = values[0] as UpstreamTopicList | undefined;
            if (next) props.onListChange(next);
          }}
        >
          {UPSTREAM_LISTS.map((entry) => (
            <ToggleGroupItem
              key={entry.id}
              value={entry.id}
              aria-current={entry.id === props.list ? "page" : undefined}
              className="gap-1.5"
            >
              {entry.label}
              <Badge variant="outline" size="sm" className="tabular-nums">
                {props.counts[entry.id]}
              </Badge>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {props.list === "inbox" && (
          <Toggle
            size="sm"
            variant="outline"
            pressed={search.question === true}
            onPressedChange={(pressed) => set({ question: pressed ? true : undefined })}
          >
            <HelpCircleIcon />
            Has question
          </Toggle>
        )}
        {props.list === "skipped" && (
          <Toggle
            size="sm"
            variant="outline"
            pressed={search.by === "llm"}
            onPressedChange={(pressed) => set({ by: pressed ? "llm" : undefined })}
          >
            <BotIcon />
            Automatic only
          </Toggle>
        )}
        {props.startAll && props.startAll.count > 0 && (
          <Button size="sm" variant="outline" disabled={props.startAll.disabled} onClick={props.startAll.onStart}>
            <PlayIcon />
            Queue all matching Ready…
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <SearchBox
            ref={searchRef}
            value={search.q ?? ""}
            onChange={(q) => set({ q: q.trim() ? q : undefined })}
            onEscape={props.onSearchEscape}
          />
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" />}>
              <ListFilterIcon />
              Filter
              {chips.length > 0 && (
                <Badge variant="primary-soft" size="sm">
                  {chips.length}
                </Badge>
              )}
            </MenuTrigger>
            <MenuPopup align="end" className="w-60">
              <MenuGroup>
                <MenuGroupLabel>Suggestion</MenuGroupLabel>
                {SUGGESTIONS.map((value) => (
                  <MenuCheckboxItem
                    key={value}
                    checked={search.suggestion?.includes(value) ?? false}
                    onCheckedChange={() => set({ suggestion: toggleValue(search.suggestion, value) })}
                  >
                    <span className="flex w-full">
                      {SUGGESTION_FILTER_LABELS[value]}
                      {count(facets?.suggestion[value])}
                    </span>
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Impact</MenuGroupLabel>
                {IMPACTS.map((value) => (
                  <MenuCheckboxItem
                    key={value}
                    checked={search.impact?.includes(value) ?? false}
                    onCheckedChange={() => set({ impact: toggleValue(search.impact, value) })}
                  >
                    <span className="flex w-full">
                      {IMPACT_LABELS[value]}
                      {count(facets?.impact[value])}
                    </span>
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
              {facets && facets.areas.length > 0 && (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Area</MenuGroupLabel>
                    <MenuRadioGroup
                      value={search.area ?? ""}
                      onValueChange={(value: string) => set({ area: value || undefined })}
                    >
                      <MenuRadioItem value="">Any area</MenuRadioItem>
                      {facets.areas.map((entry) => (
                        <MenuRadioItem key={entry.area} value={entry.area}>
                          <span className="flex w-full">
                            {entry.area}
                            {count(entry.count)}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                </>
              )}
              <MenuSeparator />
              <MenuCheckboxItem
                checked={search.question === true}
                onCheckedChange={(checked) => set({ question: checked ? true : undefined })}
              >
                Has question
              </MenuCheckboxItem>
              <MenuCheckboxItem
                checked={search.conflict === true}
                onCheckedChange={(checked) => set({ conflict: checked ? true : undefined })}
              >
                Has conflict
              </MenuCheckboxItem>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Decided by</MenuGroupLabel>
                <MenuRadioGroup
                  value={search.by ?? ""}
                  onValueChange={(value: string) => set({ by: (value || undefined) as UpstreamDecidedBy | undefined })}
                >
                  <MenuRadioItem value="">Anyone</MenuRadioItem>
                  {DECIDED_BY.map((value) => (
                    <MenuRadioItem key={value} value={value}>
                      {DECIDED_BY_LABELS[value]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </MenuPopup>
          </Menu>
          <Menu>
            <MenuTrigger render={<Button size="sm" variant="outline" aria-label={`Sort: ${SORT_LABELS[sort]}`} />}>
              <ArrowUpDownIcon />
              {SORT_LABELS[sort]}
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuRadioGroup value={sort} onValueChange={(value: string) => set({ sort: value as UpstreamTopicSort })}>
                {SORTS.map((value) => (
                  <MenuRadioItem key={value} value={value}>
                    {SORT_LABELS[value]}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </div>
      </div>
      {(chips.length > 0 || strip.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {strip.length > 0 && facets && (
            <div role="group" aria-label="Suggestions" className="flex flex-wrap items-center gap-1">
              {strip.map((value) => {
                const active = search.suggestion?.length === 1 && search.suggestion[0] === value;
                return (
                  <Button
                    key={value}
                    size="xs"
                    variant={active ? "secondary" : "ghost"}
                    aria-pressed={active}
                    onClick={() => set({ suggestion: active ? undefined : [value] })}
                  >
                    {SUGGESTION_FILTER_LABELS[value]}
                    <span className="text-muted-foreground tabular-nums">
                      {facets.suggestion[value].toLocaleString()}
                    </span>
                  </Button>
                );
              })}
            </div>
          )}
          {chips.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {chips.map((chip) => (
                <Badge key={chip.key} variant="secondary" className="gap-0.5 pe-0.5">
                  {chip.label}
                  <button
                    type="button"
                    aria-label={`Remove filter ${chip.label}`}
                    className="rounded-sm p-0.5 hover:bg-accent"
                    onClick={() => onSearchChange(chip.remove(search))}
                  >
                    <XIcon className="size-3" />
                  </button>
                </Badge>
              ))}
              <Button size="xs" variant="link" onClick={() => onSearchChange(withoutFilters(search))}>
                Clear
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
