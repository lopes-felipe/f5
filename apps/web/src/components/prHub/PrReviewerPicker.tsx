import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDownIcon, XIcon } from "lucide-react";
import type { PrHubDetail, TrackedPullRequest } from "@t3tools/contracts";

import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { Badge } from "../ui/badge";
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
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { prDetailCapability } from "./prDetails.logic";
import {
  prReviewerAllowsCustom,
  prReviewerChange,
  prReviewerOptions,
  prReviewerSet,
  type PrReviewerSet,
} from "./prReviewers";
import type { usePrDetailMutations } from "./usePrDetailMutations";

/** The forge's reviewer listing for a pull request: who reviews it now and who could. */
export function usePrReviewerCandidates(pr: TrackedPullRequest, enabled = true) {
  const generation = getPrHubAccountGeneration();
  const active = enabled && !!generation;
  const query = useQuery({
    queryKey: ["prHub", "reviewerCandidates", generation, pr.key, pr.updatedAt],
    enabled: active,
    queryFn: () =>
      ensureNativeApi().prHub.listReviewerCandidates({
        key: pr.key,
        accountGeneration: generation!,
      }),
    staleTime: 60_000,
    retry: false,
  });
  const set = useMemo(
    () => (query.data === undefined ? null : prReviewerSet(query.data, pr.provider)),
    [query.data, pr.provider],
  );
  return { set, isPending: active && query.isPending, isError: query.isError };
}

/**
 * Picks several reviewers from the forge's candidates. The selection is shown as chips
 * above the menu, so it stays readable when the menu is closed.
 */
export function PrReviewerPicker({
  pr,
  set,
  isLoading = false,
  value,
  onChange,
  disabled = false,
  label = "Reviewers",
}: {
  pr: TrackedPullRequest;
  set: PrReviewerSet | null;
  isLoading?: boolean;
  value: readonly string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [search, setSearch] = useState("");
  const options = prReviewerOptions(set, value);
  const labels = new Map(options.map((option) => [option.id, option.label]));
  const needle = search.trim().toLowerCase();
  const filtered = options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle),
  );
  const typed = search.trim();
  const allowCustom = prReviewerAllowsCustom(pr.provider, set?.candidatesSupported ?? true);
  const custom =
    allowCustom &&
    typed.length > 0 &&
    !/\s/.test(typed) &&
    !options.some(
      (option) => option.id.toLowerCase() === needle || option.label.toLowerCase() === needle,
    )
      ? typed
      : null;
  const items = [...filtered.map((option) => option.id), ...(custom ? [custom] : [])];

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {value.length > 0 ? (
        <ul aria-label={`Selected ${label.toLowerCase()}`} className="flex flex-wrap gap-1">
          {value.map((id) => {
            const name = labels.get(id) ?? id;
            return (
              <li
                key={id}
                className="inline-flex items-center gap-0.5 rounded-md bg-secondary ps-2 text-xs text-secondary-foreground"
              >
                <span className="py-0.5">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  disabled={disabled}
                  className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                  onClick={() => onChange(value.filter((selected) => selected !== id))}
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <Combobox
        multiple
        items={options.map((option) => option.id)}
        filteredItems={items}
        value={[...value]}
        autoHighlight
        onOpenChange={(open) => {
          if (!open) setSearch("");
        }}
        onValueChange={(next) => {
          onChange(next);
          setSearch("");
        }}
      >
        <ComboboxTrigger
          aria-label={label}
          disabled={disabled}
          className="flex h-7.5 w-full min-w-0 items-center justify-between gap-2 rounded-md bg-secondary px-2.5 text-sm text-foreground hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
        >
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0
              ? "Choose reviewers"
              : `${value.length} ${value.length === 1 ? "reviewer" : "reviewers"} selected`}
          </span>
          <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
        </ComboboxTrigger>
        <ComboboxPopup className="w-72">
          <div className="border-b p-2">
            <ComboboxInput
              aria-label={`Search ${label.toLowerCase()}`}
              placeholder={allowCustom ? "Search or type a login…" : "Search reviewers…"}
              showTrigger={false}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <ComboboxEmpty>
            {isLoading
              ? "Loading reviewers…"
              : allowCustom
                ? "Type a login to add it."
                : "No matching reviewers."}
          </ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {filtered.map((option, index) => (
              <ComboboxItem key={option.id} index={index} value={option.id}>
                {option.label}
              </ComboboxItem>
            ))}
            {custom ? (
              <ComboboxItem key={`custom:${custom}`} index={filtered.length} value={custom}>
                Add “{custom}”
              </ComboboxItem>
            ) : null}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  const { add, remove } = prReviewerChange(a, b);
  return add.length === 0 && remove.length === 0;
}

/**
 * Who reviews the pull request, and the editor that changes it. GitHub applies the change
 * directly; other forges prepare it and ask for confirmation, as their other writes do.
 */
export function PrReviewersSection({
  pr,
  detail,
  mutations,
  editing,
  onEditingChange,
}: {
  pr: TrackedPullRequest;
  detail: PrHubDetail | undefined;
  mutations: ReturnType<typeof usePrDetailMutations>;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const github = pr.provider === "github";
  const capability = prDetailCapability(pr, "change-reviewers");
  const caps = pr.forgeCapabilities;
  const canEdit =
    pr.state === "open" &&
    !pr.repositoryArchived &&
    (github ? capability.supported : !!caps?.reviewers.request);
  const { set, isPending, isError } = usePrReviewerCandidates(
    pr,
    editing && (github ? !!caps?.reviewers.listCandidates : true),
  );
  // GitHub reads the current requests from the detail; a team is addressed as owner/slug.
  const initial = useMemo(
    () =>
      github
        ? (detail?.reviewers ?? [])
            .filter((reviewer) => reviewer.requested)
            .map((reviewer) =>
              reviewer.kind === "team"
                ? `${pr.repository.owner}/${reviewer.login}`
                : reviewer.login,
            )
        : (set?.current.map((reviewer) => reviewer.id) ?? []),
    [github, detail?.reviewers, set, pr.repository.owner],
  );
  // The current reviewers come from the detail on GitHub and from the listing elsewhere.
  const loaded = github ? detail !== undefined : set !== null;
  const [selected, setSelected] = useState<readonly string[] | null>(null);
  const seeded = useRef(false);
  useEffect(() => {
    if (!editing) {
      seeded.current = false;
      setSelected(null);
      return;
    }
    if (seeded.current || !loaded) return;
    seeded.current = true;
    setSelected(initial);
  }, [editing, loaded, initial]);
  const value = selected ?? initial;
  const ready = loaded && (github || !!set?.known);
  const unchanged = sameSelection(initial, value);
  // The editor can be opened from the status checklist, far from this section.
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (editing) sectionRef.current?.scrollIntoView({ block: "nearest" });
  }, [editing]);

  return (
    <section
      ref={sectionRef}
      className="flex min-w-0 flex-col gap-2"
      aria-labelledby="pr-reviewers-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="pr-reviewers-heading" className="text-sm font-semibold">
          Reviewers
        </h3>
        {canEdit ? (
          <Button size="xs" variant="ghost" onClick={() => onEditingChange(!editing)}>
            {editing ? "Done" : "Request reviewers"}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {detail && detail.reviewers.length > 0 ? (
          detail.reviewers.map((reviewer) => (
            <Badge key={`${reviewer.kind}:${reviewer.login}`} variant="outline" size="sm">
              {reviewer.kind === "team" ? `@${reviewer.login}` : reviewer.login}{" "}
              {reviewer.requested ? "· requested" : "· reviewed"}
            </Badge>
          ))
        ) : pr.reviewRequestReviewers.length > 0 ? (
          pr.reviewRequestReviewers.map((reviewer) => (
            <Badge key={reviewer} variant="outline" size="sm">
              {reviewer} · requested
            </Badge>
          ))
        ) : (
          <span className="text-sm text-muted-foreground">No reviewers.</span>
        )}
      </div>
      {editing ? (
        <div
          className="flex max-w-md flex-col gap-2 rounded-lg border border-border p-3"
          role="group"
          aria-label="Reviewer selection"
        >
          {isPending ? <p className="text-xs text-muted-foreground">Loading reviewers…</p> : null}
          {isError && !github ? (
            <p role="alert" className="text-xs">
              Could not load reviewers. The current reviewers are unchanged.
            </p>
          ) : null}
          {set && !set.known && !github ? (
            <p role="alert" className="text-xs">
              Existing reviewer identities could not be verified. Refresh before changing reviewers.
            </p>
          ) : null}
          {ready ? (
            <>
              <PrReviewerPicker
                pr={pr}
                set={set}
                isLoading={isPending}
                value={value}
                onChange={setSelected}
                disabled={mutations.changeReviewers.isPending}
              />
              {github ? (
                <Button
                  size="sm"
                  className="self-start"
                  disabled={unchanged || mutations.changeReviewers.isPending}
                  onClick={() => {
                    void mutations.changeReviewers
                      .mutateAsync({ key: pr.key, ...prReviewerChange(initial, value) })
                      .then(() => onEditingChange(false))
                      .catch(() => undefined);
                  }}
                >
                  {mutations.changeReviewers.isPending ? "Updating…" : "Apply reviewer changes"}
                </Button>
              ) : (
                <ForgeOperationPanel
                  pr={pr}
                  payload={{ kind: "reviewers", reviewers: value }}
                  label="Reviewers"
                />
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
