import { useState, useEffect, useRef, useId } from "react";
import { mcpSecretId } from "@t3tools/shared/mcpSecrets";
import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";

import { readMcpKeyValueRows, mcpDuplicateKeys, type McpKeyValueRow } from "./mcpEditorValues";

export function McpKeyValueFields(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const rowId = useId();
  const rows = readMcpKeyValueRows(props.value);
  const duplicates = mcpDuplicateKeys(rows);
  const mounted = useRef(true);
  const current = useRef({ value: props.value, onChange: props.onChange });
  useEffect(() => {
    current.current = { value: props.value, onChange: props.onChange };
  }, [props.value, props.onChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = (next: McpKeyValueRow[]) => {
    props.onChange(next.length ? JSON.stringify(next) : "");
  };
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">{props.label}</p>
      {rows.map((row, index) => {
        const stored = !!mcpSecretId(row.value) && !row.replacing;
        const patch = (value: Partial<McpKeyValueRow>) =>
          update(rows.map((entry, i) => (i === index ? { ...entry, ...value } : entry)));
        const duplicate = duplicates.has(row.key.trim());
        return (
          <div key={index} className="space-y-1 rounded border p-2 text-xs">
            <Input
              aria-label={`${props.label} key ${index + 1}`}
              aria-invalid={duplicate}
              aria-describedby={duplicate ? `${rowId}-duplicate-${index}` : undefined}
              value={row.key}
              onChange={(event) => patch({ key: event.target.value })}
            />
            {stored ? (
              <p>•••••• (stored secret)</p>
            ) : (
              <Textarea
                aria-label={`${props.label} value ${index + 1}`}
                value={row.value}
                onChange={(event) => patch({ value: event.target.value })}
              />
            )}
            {duplicate ? (
              <p id={`${rowId}-duplicate-${index}`} role="alert" className="text-destructive">
                Duplicate key: {row.key.trim()}.
              </p>
            ) : null}
            {stored ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  patch({ previousValue: row.value, value: "", secret: true, replacing: true })
                }
              >
                Replace
              </Button>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!row.secret}
                    onChange={(event) => patch({ secret: event.target.checked })}
                  />
                  Secret
                </label>
                {row.secret ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null || duplicate || !row.key.trim()}
                    onClick={() => {
                      setBusy(index);
                      setError(null);
                      void ensureNativeApi()
                        .mcp.storeSecret({ value: row.value })
                        .then(({ placeholder }) => {
                          if (!mounted.current) return;
                          const latest = readMcpKeyValueRows(current.current.value);
                          const matches = latest.filter(
                            (entry) =>
                              entry.key === row.key && entry.value === row.value && entry.secret,
                          );
                          if (matches.length !== 1) {
                            setError(
                              "This value changed while storing. Your current draft was kept; store the secret again.",
                            );
                            return;
                          }
                          current.current.onChange(
                            JSON.stringify(
                              latest.map((entry) =>
                                entry === matches[0]
                                  ? {
                                      key: entry.key,
                                      value: placeholder,
                                      secret: false,
                                      replacing: false,
                                    }
                                  : entry,
                              ),
                            ),
                          );
                        })
                        .catch(() => {
                          if (mounted.current)
                            setError("Could not store secret. Your value is still in this draft.");
                        })
                        .finally(() => {
                          if (mounted.current) setBusy(null);
                        });
                    }}
                  >
                    Store secret
                  </Button>
                ) : null}
              </>
            )}
            {row.replacing && row.previousValue ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  patch({ value: row.previousValue!, secret: false, replacing: false })
                }
              >
                Cancel replacement
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              onClick={() => update(rows.filter((_, i) => i !== index))}
            >
              Remove value
            </Button>
          </div>
        );
      })}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button size="xs" variant="outline" onClick={() => update([...rows, { key: "", value: "" }])}>
        Add {props.label.toLowerCase()} value
      </Button>
    </div>
  );
}
