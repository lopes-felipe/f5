import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ProviderKind, UsagePriceOverride } from "@t3tools/contracts";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";

export function UsagePriceEditor() {
  const client = useQueryClient();
  const prices = useSettings((settings) => settings.usagePriceOverrides);
  const { updateSettings } = useUpdateSettings();
  const [provider, setProvider] = useState<ProviderKind>("codex");
  const [model, setModel] = useState("");
  const [rates, setRates] = useState(["", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (next: readonly UsagePriceOverride[]) => {
    setSaving(true);
    setError(null);
    try {
      await updateSettings({ usagePriceOverrides: [...next] });
      await client.invalidateQueries({ queryKey: ["usage", "summary"] });
    } catch {
      setError("Could not save usage prices.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <details className="rounded-xl border p-3">
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
            {price.provider} · {price.model}: input ${price.inputUsdPerMillion}, output $
            {price.outputUsdPerMillion}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setProvider(price.provider);
              setModel(price.model);
              setRates([
                String(price.inputUsdPerMillion),
                String(price.outputUsdPerMillion),
                price.cacheReadUsdPerMillion === null ? "" : String(price.cacheReadUsdPerMillion),
                price.cacheWriteUsdPerMillion === null ? "" : String(price.cacheWriteUsdPerMillion),
              ]);
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
            {["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"].map((kind) => (
              <option key={kind}>{kind}</option>
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
      {error && (
        <p role="alert" className="mt-2 text-xs">
          {error}
        </p>
      )}
    </details>
  );
}
