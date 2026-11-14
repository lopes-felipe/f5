import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { ChevronsUpDownIcon, ListFilterIcon, SearchIcon, XIcon } from "lucide-react";

import { parsePullRequestReference } from "../../lib/pullRequestReference";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  PR_QUEUE_FACETS,
  PR_QUEUE_STATUSES,
  prQueueSuggestions,
  type PrQueueFacet,
  type PrQueueFacetValues,
  type PrQueueSearch,
  type PrQueueStatus,
  type PrQueueSuggestion,
} from "./prQueueSearch";

/** Typing settles for this long before the queue is searched. */
const SEARCH_DEBOUNCE_MS = 200;

const STATUS_LABELS: Record<PrQueueStatus, string> = {
  active: "Active",
  snoozed: "Snoozed",
  ignored: "Ignored",
  closed: "Closed",
};

const FACET_LABELS: Record<PrQueueFacet, string> = {
  repo: "Repository",
  author: "Author",
  label: "Label",
  ci: "Checks",
  review: "Review",
  draft: "Draft",
};

const CHOICES = {
  ci: [
    ["success", "Passing"],
    ["failure", "Failing"],
    ["error", "Error"],
    ["pending", "Running"],
    ["none", "No checks"],
  ],
  review: [
    ["approved", "Approved"],
    ["changes_requested", "Changes requested"],
    ["review_required", "Review required"],
    ["none", "No reviews"],
  ],
  draft: [
    ["only", "Drafts only"],
    ["hide", "Hide drafts"],
  ],
} as const satisfies Record<"ci" | "review" | "draft", ReadonlyArray<readonly [string, string]>>;

function facetValueLabel(facet: PrQueueFacet, value: string): string {
  if (facet === "author" && value === "me") return "Me";
  if (facet === "ci" || facet === "review" || facet === "draft")
    return CHOICES[facet].find(([id]) => id === value)?.[1] ?? value;
  return value;
}

const sameSearch = (a: string, b: string) => a === b || (!a.trim() && !b.trim());

/** The search box: free text, qualifier completion, and opening a pasted pull request URL. */
function SearchField({
  value,
  facets,
  inputRef,
  onCommit,
  onOpenUrl,
}: {
  value: string;
  facets: PrQueueFacetValues | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onCommit: (query: string) => void;
  onOpenUrl: (url: string) => Promise<void>;
}) {
  const listId = useId();
  const [text, setText] = useState(value);
  const committed = useRef(value);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [opening, setOpening] = useState(false);

  // Back and Forward change the URL; the field follows. Blank text and no search are
  // the same search, so typing a leading space is not undone.
  useEffect(() => {
    if (sameSearch(value, committed.current)) return;
    committed.current = value;
    setText(value);
  }, [value]);

  const reference = parsePullRequestReference(text.trim());
  const commit = (next: string) => {
    if (sameSearch(next, committed.current)) return;
    committed.current = next;
    onCommit(next);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    // A pasted URL opens that pull request; it is not a search.
    if (reference) return;
    const timer = window.setTimeout(() => commitRef.current(text), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, reference !== null]);

  const suggestions: PrQueueSuggestion[] = reference
    ? [
        {
          label: `Open ${reference.repository}#${reference.number}`,
          detail: "Pull request",
          text: text.trim(),
        },
      ]
    : prQueueSuggestions(text, facets);
  const open = focused && !dismissed && suggestions.length > 0;
  const activeIndex = Math.min(active, suggestions.length - 1);

  const accept = (suggestion: PrQueueSuggestion) => {
    if (reference) {
      if (opening) return;
      setOpening(true);
      void onOpenUrl(suggestion.text)
        .then(() => {
          // Opening the pull request also clears the search, so there is nothing to commit.
          committed.current = "";
          setText("");
        })
        .catch(() => {})
        .finally(() => setOpening(false));
      return;
    }
    setText(suggestion.text);
    setActive(0);
    inputRef.current?.focus();
  };

  return (
    <div className="relative min-w-48 flex-1 basis-64">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        nativeInput
        size="sm"
        type="search"
        role="combobox"
        aria-label="Search pull requests"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={500}
        placeholder="Search, paste a PR link, or filter with repo: author: label:"
        className="[&_input]:ps-8"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setDismissed(false);
          setActive(0);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            // First Escape closes the completions, the next leaves the field.
            if (open) setDismissed(true);
            else event.currentTarget.blur();
            return;
          }
          if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((activeIndex + step + suggestions.length) % suggestions.length);
            return;
          }
          if (event.key === "Enter" || (event.key === "Tab" && open && !event.shiftKey)) {
            const suggestion = open ? suggestions[activeIndex] : undefined;
            if (suggestion) {
              event.preventDefault();
              accept(suggestion);
            } else if (event.key === "Enter") commit(text);
          }
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute top-full left-0 z-20 mt-1 w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-lg/5"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.label}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex cursor-default items-center justify-between gap-3 px-3 py-1.5 text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
              // Keep focus in the field; a click would blur it before it registers.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => accept(suggestion)}
            >
              <span className="truncate font-mono text-xs">{suggestion.label}</span>
              {suggestion.detail ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {opening ? "Opening…" : suggestion.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FacetCombobox({
  facet,
  value,
  options,
  onChange,
}: {
  facet: "repo" | "author" | "label";
  value: string | undefined;
  options: readonly string[];
  onChange: (value: string | undefined) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = options.filter((option) =>
    facetValueLabel(facet, option).toLowerCase().includes(search.toLowerCase()),
  );
  const label = FACET_LABELS[facet];
  return (
    <Combobox
      items={[...options]}
      filteredItems={filtered}
      value={value ?? null}
      autoHighlight
      onOpenChange={(open) => {
        if (!open) setSearch("");
      }}
      onValueChange={(next) => onChange(next ?? undefined)}
    >
      <ComboboxTrigger
        aria-label={label}
        className="flex h-7.5 w-full min-w-0 items-center justify-between gap-2 rounded-md bg-secondary px-2.5 text-sm text-foreground hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {value ? facetValueLabel(facet, value) : "Any"}
        </span>
        <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
      </ComboboxTrigger>
      <ComboboxPopup className="w-72">
        <div className="border-b p-2">
          <ComboboxInput
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}…`}
            showTrigger={false}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No matches in the queue.</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {filtered.map((option, index) => (
            <ComboboxItem key={option} index={index} value={option}>
              {facetValueLabel(facet, option)}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function FacetSelect({
  facet,
  value,
  onChange,
}: {
  facet: "ci" | "review" | "draft";
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Select
      value={value ?? "any"}
      onValueChange={(next) => onChange(!next || next === "any" ? undefined : next)}
    >
      <SelectTrigger size="sm" aria-label={FACET_LABELS[facet]}>
        <SelectValue>{value ? facetValueLabel(facet, value) : "Any"}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="any">Any</SelectItem>
        {CHOICES[facet].map(([id, label]) => (
          <SelectItem key={id} value={id}>
            {label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** One row: search, the filter popover with its chips, and the status segment. */
export function PrQueueToolbar({
  search,
  facets,
  searchInputRef,
  onChange,
  onOpenUrl,
}: {
  search: PrQueueSearch;
  facets: PrQueueFacetValues | undefined;
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Merges a change into the URL state; undefined clears a key. */
  onChange: (patch: Partial<Record<keyof PrQueueSearch, string | undefined>>) => void;
  onOpenUrl: (url: string) => Promise<void>;
}) {
  const activeFacets = PR_QUEUE_FACETS.filter((facet) => search[facet] !== undefined);
  const facetOptions = {
    repo: facets?.repositories ?? [],
    author: [...new Set(["me", ...(facets?.authors ?? [])])],
    label: facets?.labels ?? [],
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <SearchField
        value={search.q ?? ""}
        facets={facets}
        inputRef={searchInputRef}
        onCommit={(q) => onChange({ q: q.trim() ? q : undefined })}
        onOpenUrl={onOpenUrl}
      />
      <Popover>
        <PopoverTrigger
          render={<Button size="sm" variant="outline" aria-label="Filter pull requests" />}
        >
          <ListFilterIcon /> Filter
          {activeFacets.length > 0 ? (
            <span className="rounded-full bg-primary px-1.5 text-2xs text-primary-foreground tabular-nums">
              {activeFacets.length}
            </span>
          ) : null}
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-80">
          <div className="flex flex-col gap-3">
            {(["repo", "author", "label"] as const).map((facet) => (
              <div key={facet} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">{FACET_LABELS[facet]}</span>
                <FacetCombobox
                  facet={facet}
                  value={search[facet]}
                  options={facetOptions[facet]}
                  onChange={(value) => onChange({ [facet]: value })}
                />
              </div>
            ))}
            <div className="grid grid-cols-3 gap-2">
              {(["ci", "review", "draft"] as const).map((facet) => (
                <div key={facet} className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-medium text-foreground">{FACET_LABELS[facet]}</span>
                  <FacetSelect
                    facet={facet}
                    value={search[facet]}
                    onChange={(value) => onChange({ [facet]: value })}
                  />
                </div>
              ))}
            </div>
            <Button
              size="xs"
              variant="ghost"
              className="self-start"
              disabled={activeFacets.length === 0}
              onClick={() =>
                onChange(Object.fromEntries(PR_QUEUE_FACETS.map((facet) => [facet, undefined])))
              }
            >
              Clear filters
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
      {activeFacets.map((facet) => (
        <span
          key={facet}
          className="inline-flex h-7 max-w-56 items-center gap-1 rounded-md bg-secondary ps-2 pe-1 text-xs text-secondary-foreground"
        >
          <span className="shrink-0 text-muted-foreground">{FACET_LABELS[facet]}</span>
          <span className="truncate">{facetValueLabel(facet, search[facet]!)}</span>
          <button
            type="button"
            aria-label={`Remove ${FACET_LABELS[facet].toLowerCase()} filter`}
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => onChange({ [facet]: undefined })}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <ToggleGroup
        className="ms-auto"
        variant="outline"
        size="sm"
        aria-label="Status"
        value={[search.status ?? "active"]}
        onValueChange={(value) => {
          const next = PR_QUEUE_STATUSES.find((status) => status === value[0]);
          if (next) onChange({ status: next === "active" ? undefined : next });
        }}
      >
        {PR_QUEUE_STATUSES.map((status) => (
          <Toggle key={status} value={status}>
            {STATUS_LABELS[status]}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}
