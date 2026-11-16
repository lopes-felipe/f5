import { useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import type { ServerDraft } from "./mcpDraft";

type ArgumentRow = { id: string; value: string };

export function McpArgumentFields({
  draft,
  onChange,
}: {
  readonly draft: ServerDraft;
  readonly onChange: (patch: Partial<ServerDraft>) => void;
}) {
  const prefix = useId();
  const serial = useRef(0);
  const newRow = (value: string): ArgumentRow => ({ id: `${prefix}-${serial.current++}`, value });
  const readRows = () =>
    (draft.args === ""
      ? []
      : draft.argsFormat === "json"
        ? (JSON.parse(draft.args) as string[])
        : draft.args.split(/\r?\n/u)
    ).map(newRow);
  const [editor, setEditor] = useState(() => ({
    source: draft.args,
    format: draft.argsFormat,
    rows: readRows(),
  }));
  let rows = editor.rows;
  if (editor.source !== draft.args || editor.format !== draft.argsFormat) {
    rows = readRows();
    setEditor({ source: draft.args, format: draft.argsFormat, rows });
  }
  const empty = useRef({
    args: draft.args === "[]" ? "[]" : "",
    argsFormat: draft.args === "" ? draft.argsFormat : ("json" as const),
  });
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const focusAfterChange = useRef<string | "add" | null>(null);
  useLayoutEffect(() => {
    const target = focusAfterChange.current;
    if (target === "add") addButton.current?.focus();
    else if (target) inputs.current.get(target)?.focus();
    focusAfterChange.current = null;
  }, [rows]);
  const update = (next: ArgumentRow[], focus?: string) => {
    const patch = next.length
      ? { args: JSON.stringify(next.map((row) => row.value)), argsFormat: "json" as const }
      : empty.current;
    if (focus) focusAfterChange.current = focus;
    setEditor({ source: patch.args, format: patch.argsFormat, rows: next });
    onChange(patch);
  };
  const move = (index: number, offset: number) => {
    const next = [...rows];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    update(next, rows[index]!.id);
  };
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Arguments</p>
      <p className="text-xs text-muted-foreground">
        Passed in order. Empty values, whitespace, and line breaks are preserved.
      </p>
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-start gap-2">
          <span className="pt-2 text-xs text-muted-foreground">{index + 1}</span>
          <Textarea
            aria-label={`Argument ${index + 1}`}
            value={row.value}
            className="min-h-9 font-mono"
            ref={(node) => {
              if (node) inputs.current.set(row.id, node);
              else inputs.current.delete(row.id);
            }}
            onChange={(event) =>
              update(
                rows.map((entry) =>
                  entry.id === row.id ? { ...entry, value: event.target.value } : entry,
                ),
              )
            }
          />
          <Button
            size="xs"
            variant="outline"
            aria-label={`Move argument ${index + 1} up`}
            disabled={index === 0}
            onClick={() => move(index, -1)}
          >
            ↑
          </Button>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Move argument ${index + 1} down`}
            disabled={index === rows.length - 1}
            onClick={() => move(index, 1)}
          >
            ↓
          </Button>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Remove argument ${index + 1}`}
            onClick={() =>
              update(
                rows.filter((entry) => entry.id !== row.id),
                rows[index + 1]?.id ?? rows[index - 1]?.id ?? "add",
              )
            }
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        ref={addButton}
        size="xs"
        variant="outline"
        onClick={() => {
          const row = newRow("");
          update([...rows, row], row.id);
        }}
      >
        Add argument
      </Button>
    </div>
  );
}
