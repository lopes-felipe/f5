import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  KNOWN_PROVIDER_KINDS,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type UsagePriceOverride,
} from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { refreshUsageSummaries } from "../../lib/usageReactQuery";
import { Button } from "../ui/button";

export interface UsagePriceDraft {
  readonly provider: ProviderKind;
  readonly model: string;
  /** Changes on every request so repeated clicks re-open the editor. */
  readonly nonce: number;
}

function priceRates(price: UsagePriceOverride): Array<string> {
  return [
    String(price.inputUsdPerMillion),
    String(price.outputUsdPerMillion),
    price.cacheReadUsdPerMillion === null ? "" : String(price.cacheReadUsdPerMillion),
    price.cacheWriteUsdPerMillion === null ? "" : String(price.cacheWriteUsdPerMillion),
  ];
}

export function UsagePriceEditor({ draft }: { draft?: UsagePriceDraft | null }) {
  const client = useQueryClient();
  const prices = useSettings((settings) => settings.usagePriceOverrides);
  const aliases = useSettings((settings) => settings.usageModelAliases);
  const { updateSettings } = useUpdateSettings();
  const [provider, setProvider] = useState<ProviderKind>("codex");
  const [model, setModel] = useState("");
  const [rates, setRates] = useState(["", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [aliasModel, setAliasModel] = useState("");
  const [aliasTarget, setAliasTarget] = useState("");
  const inputPriceRef = useRef<HTMLInputElement | null>(null);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  useEffect(() => {
    if (!draft) return;
    setProvider(draft.provider);
    setModel(draft.model);
    // An existing override can still leave turns unpriced (missing token
    // counts); start from it rather than blank rates.
    const existing = prices.find(
      (price) => price.provider === draft.provider && price.model === draft.model,
    );
    setRates(existing ? priceRates(existing) : ["", "", "", ""]);
    setError(null);
    setOpen(true);
    setFocusRequest(draft.nonce);
    // Only a new draft (nonce) prefills; later price edits must not reset the form.
  }, [draft]);
  // Focus only after the details element has rendered open.
  useEffect(() => {
    if (!open || focusRequest === null) return;
    const input = inputPriceRef.current;
    input?.scrollIntoView?.({ block: "nearest" });
    input?.focus();
    setFocusRequest(null);
  }, [open, focusRequest]);
  const persist = async (
    patch: Parameters<typeof updateSettings>[0],
    failure: string,
  ): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await updateSettings(patch);
      await refreshUsageSummaries(client);
      return true;
    } catch {
      setError(failure);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = (next: readonly UsagePriceOverride[]) =>
    persist({ usagePriceOverrides: [...next] }, "Could not save usage prices.");
  const saveAliases = (next: Readonly<Record<string, string>>) =>
    persist({ usageModelAliases: { ...next } }, "Could not save model mappings.");
  return (
    <details
      className="rounded-xl border p-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">Usage prices</summary>
      <p className="my-2 text-xs text-muted-foreground">
        USD per million tokens. Overrides apply only when the provider omits cost. Blank cache rates
        inherit the input rate; zero is a valid price.
      </p>
      {prices.map((price) => (
        <div
          key={`${price.provider}:${price.model}`}
          className="flex items-center justify-between gap-2 py-1 text-xs"
        >
          <span>
            {PROVIDER_DISPLAY_NAMES[price.provider]} · {price.model}: input $
            {price.inputUsdPerMillion}, output ${price.outputUsdPerMillion}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setProvider(price.provider);
              setModel(price.model);
              setRates(priceRates(price));
            }}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void save(prices.filter((entry) => entry !== price))}
          >
            Remove
          </Button>
        </div>
      ))}
      <form
        className="mt-3 grid gap-2 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = rates.map((rate) => (rate.trim() === "" ? null : Number(rate)));
          if (
            !model.trim() ||
            parsed[0] === null ||
            parsed[1] === null ||
            parsed.some((rate) => rate !== null && (!Number.isFinite(rate) || rate < 0))
          ) {
            setError("Enter a model and non-negative input and output prices.");
            return;
          }
          const price: UsagePriceOverride = {
            provider,
            model: model.trim(),
            inputUsdPerMillion: parsed[0]!,
            outputUsdPerMillion: parsed[1]!,
            cacheReadUsdPerMillion: parsed[2] ?? null,
            cacheWriteUsdPerMillion: parsed[3] ?? null,
          };
          void save([
            ...prices.filter((entry) => entry.provider !== provider || entry.model !== price.model),
            price,
          ]);
        }}
      >
        <label className="text-xs">
          Provider
          <select
            className="block w-full rounded border p-2"
            value={provider}
            onChange={(event) => setProvider(event.target.value as ProviderKind)}
          >
            {KNOWN_PROVIDER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {PROVIDER_DISPLAY_NAMES[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Model
          <input
            className="block w-full rounded border p-2"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        {["Input price", "Output price", "Cache read price", "Cache write price"].map(
          (label, index) => (
            <label key={label} className="text-xs">
              {label}
              <input
                ref={index === 0 ? inputPriceRef : undefined}
                className="block w-full rounded border p-2"
                type="number"
                min="0"
                step="any"
                value={rates[index]}
                onChange={(event) =>
                  setRates((prior) =>
                    prior.map((rate, position) => (position === index ? event.target.value : rate)),
                  )
                }
              />
            </label>
          ),
        )}
        <Button type="submit" disabled={saving}>
          Save price
        </Button>
      </form>
      <section aria-label="Model mappings" className="mt-4 space-y-2 border-t pt-3">
        <h3 className="text-sm font-medium">Model mappings</h3>
        <p className="text-xs text-muted-foreground">
          Count one model as another, such as a preview model under its released name. A mapped
          model leaves Usage: its tokens and cost move to the target and use the target&apos;s
          price.
        </p>
        {Object.entries(aliases).map(([source, target]) => (
          <div key={source} className="flex items-center justify-between gap-2 py-1 text-xs">
            <span>
              {source} → {target}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              aria-label={`Remove mapping for ${source}`}
              onClick={() =>
                void saveAliases(
                  Object.fromEntries(Object.entries(aliases).filter(([key]) => key !== source)),
                )
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <form
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            const source = aliasModel.trim();
            const target = aliasTarget.trim();
            if (!source || !target || source === target) {
              setError("Enter two different model IDs to map.");
              return;
            }
            void saveAliases({ ...aliases, [source]: target }).then((saved) => {
              if (!saved) return;
              setAliasModel("");
              setAliasTarget("");
            });
          }}
        >
          <label className="text-xs">
            Mapped model
            <input
              className="block w-full rounded border p-2"
              value={aliasModel}
              placeholder="gpt-5.6-preview"
              onChange={(event) => setAliasModel(event.target.value)}
            />
          </label>
          <label className="text-xs">
            Map to
            <input
              className="block w-full rounded border p-2"
              value={aliasTarget}
              placeholder="gpt-5.6"
              onChange={(event) => setAliasTarget(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={saving}>
            Save mapping
          </Button>
        </form>
      </section>
      {error && (
        <p role="alert" className="mt-2 text-xs">
          {error}
        </p>
      )}
    </details>
  );
}
