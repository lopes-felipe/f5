import type {
  ProviderKind,
  UsageMonthlyBudget,
  UsagePriceOverride,
  UsageSummary,
} from "@t3tools/contracts";
import { ArrowRightIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useSettings } from "../../hooks/useSettings";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../ui/input-group";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { providerLabel, totalCost } from "./format";
import { type UsageColumn, type UsageSort, UsageSection, UsageTable } from "./kit";
import { useUsageSettingsSave } from "./UsagePriceDialog";

export interface PricingModelRow {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly turns: number;
  readonly unpricedTurnCount: number;
  readonly costUsd: number;
  readonly override: UsagePriceOverride | null;
}

/** Models in range plus saved overrides for models outside it; unpriced first, then cost. */
export function pricingModelRows(
  summary: UsageSummary | undefined,
  overrides: ReadonlyArray<UsagePriceOverride>,
): Array<PricingModelRow> {
  const rows = new Map<string, PricingModelRow>();
  const key = (provider: ProviderKind, model: string) => `${provider}\u0000${model}`;
  const overrideFor = (provider: ProviderKind, model: string) =>
    overrides.find((entry) => entry.provider === provider && entry.model === model) ?? null;
  for (const entry of summary?.byProvider ?? []) {
    if (entry.model === null) continue;
    const existing = rows.get(key(entry.provider, entry.model));
    rows.set(key(entry.provider, entry.model), {
      provider: entry.provider,
      model: entry.model,
      turns: (existing?.turns ?? 0) + entry.metrics.turnCount,
      unpricedTurnCount: (existing?.unpricedTurnCount ?? 0) + entry.metrics.unpricedTurnCount,
      costUsd: (existing?.costUsd ?? 0) + totalCost(entry.metrics),
      override: overrideFor(entry.provider, entry.model),
    });
  }
  for (const override of overrides)
    if (!rows.has(key(override.provider, override.model)))
      rows.set(key(override.provider, override.model), {
        provider: override.provider,
        model: override.model,
        turns: 0,
        unpricedTurnCount: 0,
        costUsd: 0,
        override,
      });
  return [...rows.values()].sort(
    (left, right) =>
      Number(right.unpricedTurnCount > 0) - Number(left.unpricedTurnCount > 0) ||
      right.unpricedTurnCount - left.unpricedTurnCount ||
      right.costUsd - left.costUsd ||
      left.model.localeCompare(right.model),
  );
}

/** Models with a known name and unpriced turns; drives the tab badge and Activity alert. */
export function unpricedModelCount(summary: UsageSummary | undefined): number {
  const models = new Set<string>();
  for (const entry of summary?.byProvider ?? [])
    if (entry.model !== null && entry.metrics.unpricedTurnCount > 0)
      models.add(`${entry.provider}\u0000${entry.model}`);
  return models.size;
}

function rate(value: number): string {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function overrideText(price: UsagePriceOverride): string {
  const cache =
    price.cacheReadUsdPerMillion === null && price.cacheWriteUsdPerMillion === null
      ? ""
      : ` · cache ${rate(price.cacheReadUsdPerMillion ?? price.inputUsdPerMillion)} / ${rate(
          price.cacheWriteUsdPerMillion ?? price.inputUsdPerMillion,
        )}`;
  return `${rate(price.inputUsdPerMillion)} in · ${rate(price.outputUsdPerMillion)} out${cache}`;
}

function CostSourceBadge(props: { readonly row: PricingModelRow }) {
  if (props.row.unpricedTurnCount > 0)
    return (
      <Badge size="sm" variant="warning">
        Unpriced · {props.row.unpricedTurnCount}
      </Badge>
    );
  if (props.row.override)
    return (
      <Badge size="sm" variant="primary-soft">
        Override
      </Badge>
    );
  return (
    <Badge size="sm" variant="secondary">
      {props.row.turns === 0 ? "No turns in range" : "Reported"}
    </Badge>
  );
}

function ModelsSection(props: {
  readonly summary: UsageSummary | undefined;
  readonly loading: boolean;
  readonly onSetPrice: (provider: ProviderKind, model: string) => void;
}) {
  const overrides = useSettings((settings) => settings.usagePriceOverrides);
  const { saving, save } = useUsageSettingsSave();
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<UsageSort | null>(null);
  const rows = pricingModelRows(props.summary, overrides);
  const remove = (override: UsagePriceOverride) =>
    void save(
      { usagePriceOverrides: overrides.filter((entry) => entry !== override) },
      "Could not save usage prices.",
    ).then(setError);
  const columns: Array<UsageColumn<PricingModelRow>> = [
    {
      key: "provider",
      header: "Provider",
      sortValue: (row) => providerLabel(row.provider),
      className: "font-medium text-foreground",
      render: (row) => providerLabel(row.provider),
    },
    {
      key: "model",
      header: "Model",
      sortValue: (row) => row.model,
      className: "max-w-64 truncate font-mono",
      render: (row) => row.model,
    },
    {
      key: "turns",
      header: "Turns",
      align: "right",
      sortValue: (row) => row.turns,
      render: (row) => row.turns.toLocaleString(),
    },
    {
      key: "source",
      header: "Cost source",
      render: (row) => <CostSourceBadge row={row} />,
    },
    {
      key: "override",
      header: "Override price",
      className: "font-mono text-2xs",
      render: (row) =>
        row.override ? (
          overrideText(row.override)
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      render: (row) => (
        <span className="inline-flex items-center justify-end gap-1">
          {row.override ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Edit price for ${row.model}`}
                disabled={saving}
                onClick={() => props.onSetPrice(row.provider, row.model)}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove price for ${row.model}`}
                disabled={saving}
                onClick={() => remove(row.override!)}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant={row.unpricedTurnCount > 0 ? "outline" : "ghost"}
              aria-label={`Set price for ${row.model}`}
              onClick={() => props.onSetPrice(row.provider, row.model)}
            >
              Set price
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <UsageSection
      title="Models"
      description="USD per 1M tokens. Overrides apply only when the provider omits cost."
      flush
      actions={
        <Button size="xs" variant="outline" onClick={() => props.onSetPrice("codex", "")}>
          <PlusIcon aria-hidden="true" />
          Add price
        </Button>
      }
    >
      {error ? (
        <Alert variant="error" className="mx-4 mb-3 w-auto">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      ) : null}
      {props.loading && rows.length === 0 ? (
        <div
          className="space-y-2 border-t border-border/70 p-4"
          role="status"
          aria-label="Loading models"
        >
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-7 w-full" />
          ))}
        </div>
      ) : (
        <UsageTable
          caption="Model prices"
          columns={columns}
          rows={rows}
          rowKey={(row) => `${row.provider}:${row.model}`}
          sort={sort}
          onSortChange={setSort}
          empty="No models in this range and no saved overrides. Use Add price to price a model before it appears."
        />
      )}
    </UsageSection>
  );
}

function MappingsSection() {
  const aliases = useSettings((settings) => settings.usageModelAliases);
  const { saving, save } = useUsageSettingsSave();
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const entries = Object.entries(aliases);
  return (
    <UsageSection
      title="Model mappings"
      aria-label="Model mappings"
      description="Count a model's usage under another model's name and price."
      info="A mapped model leaves Usage: its tokens and cost move to the target and use the target's price. Useful for preview models under their released name."
    >
      <div className="space-y-3">
        {entries.length > 0 ? (
          <ul className="divide-y divide-border/50 rounded-lg border border-border/60">
            {entries.map(([from, to]) => (
              <li key={from} className="flex items-center justify-between gap-2 px-3 py-1.5">
                <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
                  <span className="truncate">{from}</span>
                  <ArrowRightIcon
                    aria-hidden="true"
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                  <span className="sr-only">maps to</span>
                  <span className="truncate">{to}</span>
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={saving}
                  aria-label={`Remove mapping for ${from}`}
                  onClick={() =>
                    void save(
                      {
                        usageModelAliases: Object.fromEntries(
                          entries.filter(([key]) => key !== from),
                        ),
                      },
                      "Could not save model mappings.",
                    ).then(setError)
                  }
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No mappings.</p>
        )}
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            const from = source.trim();
            const to = target.trim();
            if (!from || !to || from === to) {
              setError("Enter two different model IDs to map.");
              return;
            }
            void save(
              { usageModelAliases: { ...aliases, [from]: to } },
              "Could not save model mappings.",
            ).then((failure) => {
              setError(failure);
              if (failure) return;
              setSource("");
              setTarget("");
            });
          }}
        >
          <Input
            size="sm"
            className="font-mono sm:flex-1"
            aria-label="Mapped model"
            placeholder="gpt-5.6-preview"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          <ArrowRightIcon
            aria-hidden="true"
            className="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
          />
          <Input
            size="sm"
            className="font-mono sm:flex-1"
            aria-label="Map to"
            placeholder="gpt-5.6"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={saving}>
            Add mapping
          </Button>
        </form>
        {error ? (
          <Alert variant="error">
            <AlertDescription className="text-xs">{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    </UsageSection>
  );
}

/** Parses budget fields; blank means "no budget" for that measure. */
export function parseBudgetForm(input: {
  readonly costUsd: string;
  readonly tokens: string;
}): UsageMonthlyBudget | null | string {
  const cost = input.costUsd.trim() === "" ? null : Number(input.costUsd);
  const tokens =
    input.tokens.replaceAll(/[,_\s]/g, "") === ""
      ? null
      : Number(input.tokens.replaceAll(/[,_\s]/g, ""));
  // Zero would save but read as "no budget" everywhere, so ask for empty instead.
  if (cost !== null && (!Number.isFinite(cost) || cost <= 0))
    return "Enter a cost budget above $0, or leave it empty.";
  if (tokens !== null && (!Number.isInteger(tokens) || tokens <= 0))
    return "Enter a whole token budget above 0, or leave it empty.";
  if (cost === null && tokens === null) return null;
  return { costUsd: cost, tokens };
}

function BudgetSection() {
  const budget = useSettings((settings) => settings.usageMonthlyBudget);
  const { saving, save } = useUsageSettingsSave();
  const [cost, setCost] = useState("");
  const [tokens, setTokens] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setCost(budget?.costUsd == null ? "" : String(budget.costUsd));
    setTokens(budget?.tokens == null ? "" : String(budget.tokens));
  }, [budget]);
  const persist = (next: UsageMonthlyBudget | null) =>
    void save({ usageMonthlyBudget: next }, "Could not save the monthly budget.").then(
      (failure) => {
        setError(failure);
        setSaved(failure === null);
      },
    );
  return (
    <UsageSection
      title="Monthly budget"
      aria-label="Monthly budget"
      description="Counts all providers and projects. Activity warns when the month-end forecast goes over."
    >
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseBudgetForm({ costUsd: cost, tokens });
          if (typeof parsed === "string") {
            setError(parsed);
            setSaved(false);
            return;
          }
          persist(parsed);
        }}
      >
        <div className="flex flex-col gap-1.5 sm:flex-1">
          <Label className="text-xs" htmlFor="usage-budget-cost">
            Cost budget
          </Label>
          <InputGroup>
            <InputGroupAddon>
              <InputGroupText>$</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              id="usage-budget-cost"
              size="sm"
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              placeholder="No limit"
              value={cost}
              onChange={(event) => {
                setCost(event.target.value);
                setSaved(false);
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText className="text-2xs whitespace-nowrap">/ month</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex flex-col gap-1.5 sm:flex-1">
          <Label className="text-xs" htmlFor="usage-budget-tokens">
            Token budget
          </Label>
          <InputGroup>
            <InputGroupInput
              id="usage-budget-tokens"
              size="sm"
              inputMode="numeric"
              placeholder="No limit"
              value={tokens}
              onChange={(event) => {
                setTokens(event.target.value);
                setSaved(false);
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText className="text-2xs whitespace-nowrap">tokens / month</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving || budget === null}
            onClick={() => persist(null)}
          >
            Clear
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            Save budget
          </Button>
        </div>
      </form>
      {error ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      ) : saved ? (
        <p role="status" className="mt-2 text-2xs text-muted-foreground">
          Budget saved.
        </p>
      ) : null}
    </UsageSection>
  );
}

export function UsagePricingPanel(props: {
  readonly summary: UsageSummary | undefined;
  readonly loading: boolean;
  readonly onSetPrice: (provider: ProviderKind, model: string) => void;
}) {
  return (
    <section aria-label="Pricing" className="flex flex-col gap-4">
      <ModelsSection
        summary={props.summary}
        loading={props.loading}
        onSetPrice={props.onSetPrice}
      />
      <MappingsSection />
      <BudgetSection />
    </section>
  );
}
