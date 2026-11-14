import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import {
  KNOWN_PROVIDER_KINDS,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type UsagePriceOverride,
} from "@t3tools/contracts";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { refreshUsageSummaries } from "../../lib/usageReactQuery";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "../ui/input-group";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export interface UsagePriceDraft {
  readonly provider: ProviderKind;
  /** Empty for a new entry. */
  readonly model: string;
  /** Changes on every request so repeated clicks re-open the dialog. */
  readonly nonce: number;
}

type SettingsPatch = Parameters<ReturnType<typeof useUpdateSettings>["updateSettings"]>[0];

/** Saves a usage settings patch and refreshes summaries; resolves to an error message or null. */
export function useUsageSettingsSave() {
  const client = useQueryClient();
  const { updateSettings } = useUpdateSettings();
  const [saving, setSaving] = useState(false);
  const save = async (patch: SettingsPatch, failure: string): Promise<string | null> => {
    setSaving(true);
    try {
      await updateSettings(patch);
      await refreshUsageSummaries(client);
      return null;
    } catch {
      return failure;
    } finally {
      setSaving(false);
    }
  };
  return { saving, save };
}

function rateText(value: number | null): string {
  return value === null ? "" : String(value);
}

const RATE_FIELDS = [
  { key: "input", label: "Input price" },
  { key: "output", label: "Output price" },
  { key: "cacheRead", label: "Cache read price" },
  { key: "cacheWrite", label: "Cache write price" },
] as const;

type RateKey = (typeof RATE_FIELDS)[number]["key"];
type Rates = Record<RateKey, string>;
const EMPTY_RATES: Rates = { input: "", output: "", cacheRead: "", cacheWrite: "" };

function priceRates(price: UsagePriceOverride): Rates {
  return {
    input: rateText(price.inputUsdPerMillion),
    output: rateText(price.outputUsdPerMillion),
    cacheRead: rateText(price.cacheReadUsdPerMillion),
    cacheWrite: rateText(price.cacheWriteUsdPerMillion),
  };
}

/** Parses the form; returns the override or a validation message. */
export function parsePriceForm(input: {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly rates: Rates;
}): UsagePriceOverride | string {
  const parse = (value: string) => (value.trim() === "" ? null : Number(value));
  const input_ = parse(input.rates.input);
  const output = parse(input.rates.output);
  const cacheRead = parse(input.rates.cacheRead);
  const cacheWrite = parse(input.rates.cacheWrite);
  if (
    !input.model.trim() ||
    input_ === null ||
    output === null ||
    [input_, output, cacheRead, cacheWrite].some(
      (rate) => rate !== null && (!Number.isFinite(rate) || rate < 0),
    )
  )
    return "Enter a model and non-negative input and output prices.";
  return {
    provider: input.provider,
    model: input.model.trim(),
    inputUsdPerMillion: input_,
    outputUsdPerMillion: output,
    cacheReadUsdPerMillion: cacheRead,
    cacheWriteUsdPerMillion: cacheWrite,
  };
}

/**
 * Replaces `original` (when editing) and any entry with the new key, so renaming a
 * model or changing its provider never leaves a duplicate.
 */
export function upsertPriceOverride(
  prices: ReadonlyArray<UsagePriceOverride>,
  price: UsagePriceOverride,
  original: { readonly provider: ProviderKind; readonly model: string } | null,
): Array<UsagePriceOverride> {
  const same = (entry: UsagePriceOverride, key: { provider: ProviderKind; model: string }) =>
    entry.provider === key.provider && entry.model === key.model;
  return [
    ...prices.filter((entry) => !same(entry, price) && !(original && same(entry, original))),
    price,
  ];
}

/** Add or edit one usage price override. Opens for every new `draft` nonce. */
export function UsagePriceDialog(props: {
  readonly draft: UsagePriceDraft | null;
  readonly onClose: () => void;
}) {
  const prices = useSettings((settings) => settings.usagePriceOverrides);
  const { saving, save } = useUsageSettingsSave();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ProviderKind>("codex");
  const [model, setModel] = useState("");
  const [rates, setRates] = useState<Rates>(EMPTY_RATES);
  const [original, setOriginal] = useState<{ provider: ProviderKind; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputPriceRef = useRef<HTMLInputElement | null>(null);
  const modelRef = useRef<HTMLInputElement | null>(null);
  const id = useId();
  const { draft } = props;
  useEffect(() => {
    if (!draft) return;
    // An existing override can still leave turns unpriced (missing token
    // counts); start from it rather than blank rates.
    const existing = prices.find(
      (price) => price.provider === draft.provider && price.model === draft.model,
    );
    setProvider(draft.provider);
    setModel(draft.model);
    setRates(existing ? priceRates(existing) : EMPTY_RATES);
    setOriginal(existing ? { provider: existing.provider, model: existing.model } : null);
    setError(null);
    setOpen(true);
    // Only a new draft (nonce) prefills; later price edits must not reset the form.
  }, [draft]);

  const close = () => {
    setOpen(false);
    props.onClose();
  };
  const cacheHint = rates.input.trim() === "" ? "Same as input" : `${rates.input.trim()} (input)`;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogPopup
        className="max-w-md"
        initialFocus={draft?.model ? inputPriceRef : modelRef}
        bottomStickOnMobile={false}
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parsePriceForm({ provider, model, rates });
            if (typeof parsed === "string") {
              setError(parsed);
              return;
            }
            setError(null);
            void save(
              { usagePriceOverrides: upsertPriceOverride(prices, parsed, original) },
              "Could not save usage prices.",
            ).then((failure) => {
              if (failure) setError(failure);
              else close();
            });
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base">{original ? "Edit price" : "Set price"}</DialogTitle>
            <DialogDescription className="text-xs">
              USD per 1M tokens. Blank cache rates use the input rate; 0 is valid.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs" id={`${id}-provider`}>
                Provider
              </Label>
              <Select
                value={provider}
                onValueChange={(value) => {
                  if (value) setProvider(value as ProviderKind);
                }}
              >
                <SelectTrigger size="sm" aria-labelledby={`${id}-provider`}>
                  <SelectValue>{PROVIDER_DISPLAY_NAMES[provider]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {KNOWN_PROVIDER_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {PROVIDER_DISPLAY_NAMES[kind]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs" htmlFor={`${id}-model`}>
                Model
              </Label>
              <Input
                id={`${id}-model`}
                ref={modelRef}
                size="sm"
                className="font-mono"
                value={model}
                placeholder="gpt-5.6"
                onChange={(event) => setModel(event.target.value)}
              />
            </div>
            {RATE_FIELDS.map((field) => (
              <div key={field.key} className="flex flex-col gap-1.5">
                <Label className="text-xs" htmlFor={`${id}-${field.key}`}>
                  {field.label}
                </Label>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText>$</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    id={`${id}-${field.key}`}
                    ref={field.key === "input" ? inputPriceRef : undefined}
                    size="sm"
                    type="number"
                    min="0"
                    step="any"
                    inputMode="decimal"
                    className="tabular-nums"
                    placeholder={
                      field.key === "cacheRead" || field.key === "cacheWrite" ? cacheHint : "0.00"
                    }
                    value={rates[field.key]}
                    onChange={(event) =>
                      setRates((prior) => ({ ...prior, [field.key]: event.target.value }))
                    }
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText className="text-2xs whitespace-nowrap">/ 1M</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
              </div>
            ))}
            {error ? (
              <Alert variant="error" className="sm:col-span-2">
                <AlertDescription className="text-xs">{error}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              Save price
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
