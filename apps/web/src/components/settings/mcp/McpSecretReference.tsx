import { useState } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

/**
 * Stores a value in F5's encrypted secret store and shows its `${f5-secret:…}`
 * reference, to paste into an argument, the URL, or part of a header or
 * environment value. F5 swaps the value in only when it starts the server.
 */
export function McpSecretReference() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [reference, setReference] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  if (!open)
    return (
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        Store a secret for an argument or URL
      </Button>
    );
  return (
    <div
      role="group"
      aria-label="Store a secret"
      className="space-y-2 rounded-md border border-border p-2 text-xs"
    >
      <p className="text-muted-foreground">
        Paste the reference anywhere in an argument, the URL, or a header or environment value. F5
        swaps in the secret when it starts the server; agents never see it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="password"
          aria-label="Secret value"
          className="min-w-48 flex-1 font-mono"
          value={value}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          size="xs"
          disabled={busy || value.length === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            void ensureNativeApi()
              .mcp.storeSecret({ value })
              .then(({ placeholder }) => {
                setReference(placeholder);
                setValue("");
              })
              .catch(() => setError("Could not store the secret."))
              .finally(() => setBusy(false));
          }}
        >
          Store
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setValue("");
            setReference(null);
          }}
        >
          Close
        </Button>
      </div>
      {reference ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-muted/40 px-1 py-0.5">{reference}</code>
          <Button size="xs" variant="outline" onClick={() => void copyToClipboard(reference)}>
            {isCopied ? "Copied" : "Copy reference"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
