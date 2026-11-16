import type {
  McpConfigScope,
  McpImportCandidate,
  McpListImportCandidatesResult,
  McpProjectServersConfig,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { parseMcpImport } from "@t3tools/shared/mcpImport";
import { mcpServerNameKey, validateMcpLayerWrite } from "@t3tools/shared/mcpValidation";
import { useMemo, useState } from "react";
import { ensureNativeApi } from "../../../nativeApi";
import { Button } from "../../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../../ui/dialog";
import { Textarea } from "../../ui/textarea";
import { readErrorMessage } from "./mcpSettingsHelpers";

export function McpImportDialog(props: {
  scope: McpConfigScope;
  projectId: ProjectId | null;
  instanceId: ProviderInstanceId;
  servers: McpProjectServersConfig;
  version?: string | undefined;
  onImport: (servers: McpProjectServersConfig, expectedVersion?: string) => Promise<unknown>;
  onRefreshBase: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<"Detected" | "Paste">("Paste");
  const [text, setText] = useState("");
  const [detected, setDetected] = useState<McpListImportCandidatesResult>({
    candidates: [],
    issues: [],
  });
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [replace, setReplace] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = useMemo(
    () =>
      tab === "Detected"
        ? detected
        : text.trim()
          ? parseMcpImport(text)
          : { candidates: [], issues: [] },
    [tab, detected, text],
  );
  const conflict = (entry: McpImportCandidate) =>
    Object.keys(props.servers).find(
      (name) => mcpServerNameKey(name) === mcpServerNameKey(entry.name),
    );
  const selected = (entry: McpImportCandidate) =>
    choices[entry.id] ??
    (entry.selectedByDefault !== false &&
      !!entry.server &&
      !entry.issues.some((issue) => issue.severity === "error"));
  const preview = useMemo(() => {
    const next = { ...props.servers };
    let additions = 0,
      conflicts = 0,
      skipped = 0,
      imported = 0;
    let invalid = false;
    const includedNames = new Set<string>();
    for (const entry of parsed.candidates) {
      const existing = Object.keys(props.servers).find(
        (name) => mcpServerNameKey(name) === mcpServerNameKey(entry.name),
      );
      if (existing) conflicts++;
      const include =
        choices[entry.id] ??
        (entry.selectedByDefault !== false &&
          !!entry.server &&
          !entry.issues.some((issue) => issue.severity === "error"));
      if (!include || (existing && !replace[entry.id])) {
        skipped++;
        continue;
      }
      if (!entry.server || entry.issues.some((issue) => issue.severity === "error")) {
        invalid = true;
        continue;
      }
      if (includedNames.has(mcpServerNameKey(entry.name))) invalid = true;
      includedNames.add(mcpServerNameKey(entry.name));
      if (existing) delete next[existing];
      else additions++;
      next[entry.name] = entry.server;
      imported++;
    }
    let validation: string | null = invalid ? "Every selected candidate must be valid." : null;
    try {
      validateMcpLayerWrite(props.servers, next);
    } catch (cause) {
      validation = readErrorMessage(cause, "Invalid import.");
    }
    return {
      next,
      additions,
      conflicts,
      skipped,
      imported,
      validation,
      count: Object.keys(next).length,
    };
  }, [props.servers, parsed, choices, replace]);
  const duplicateNames = new Set(
    parsed.candidates
      .filter((entry) => selected(entry))
      .filter((entry, index, entries) =>
        entries.some(
          (other, i) =>
            i !== index && mcpServerNameKey(other.name) === mcpServerNameKey(entry.name),
        ),
      )
      .map((entry) => mcpServerNameKey(entry.name)),
  );
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Import configuration
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl overflow-y-auto p-5">
          <DialogTitle>Import MCP servers</DialogTitle>
          <div className="my-3 flex gap-2" role="tablist" aria-label="Import source">
            {(["Detected", "Paste"] as const).map((value) => (
              <Button
                key={value}
                role="tab"
                aria-selected={tab === value}
                variant={tab === value ? "secondary" : "outline"}
                onClick={() => setTab(value)}
              >
                {value}
              </Button>
            ))}
          </div>
          {tab === "Paste" ? (
            <Textarea
              aria-label="Configuration to import"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-36 font-mono text-xs"
              placeholder="Paste F5/Claude JSON or Codex JSON/TOML"
            />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Reads Claude user and project configuration, this project's .mcp.json, and the
                selected account's Codex config. Nothing is applied automatically.
              </p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void ensureNativeApi()
                    .mcp.listImportCandidates({
                      ...(props.projectId ? { projectId: props.projectId } : {}),
                      instanceId: props.instanceId,
                    })
                    .then(setDetected)
                    .catch((cause) => setError(readErrorMessage(cause, "Detection failed.")))
                    .finally(() => setBusy(false));
                }}
              >
                Detect configurations
              </Button>
            </>
          )}
          <div className="my-3 space-y-3">
            {parsed.issues.map((issue, index) => (
              <p key={index} className="text-xs text-destructive">
                {issue.field}: {issue.message}
              </p>
            ))}
            {parsed.candidates.map((entry) => (
              <div key={entry.id} className="rounded border p-2 text-xs">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selected(entry)}
                    onChange={(event) =>
                      setChoices((old) => ({ ...old, [entry.id]: event.target.checked }))
                    }
                  />
                  {entry.name}
                </label>
                <p className="break-all text-muted-foreground">{entry.source}</p>
                {conflict(entry) ? (
                  <label>
                    Same-name conflict:{" "}
                    <select
                      aria-label={`Conflict for ${entry.name}`}
                      value={replace[entry.id] ? "replace" : "keep"}
                      onChange={(event) =>
                        setReplace((old) => ({
                          ...old,
                          [entry.id]: event.target.value === "replace",
                        }))
                      }
                    >
                      <option value="keep">Keep existing</option>
                      <option value="replace">Replace</option>
                    </select>
                  </label>
                ) : null}
                {duplicateNames.has(mcpServerNameKey(entry.name)) ? (
                  <p className="text-destructive">
                    Duplicate selected name. Select only one candidate with this name.
                  </p>
                ) : null}
                {entry.issues.map((issue, index) => (
                  <p key={index}>
                    {issue.severity}: {issue.field}: {issue.message}
                  </p>
                ))}
              </div>
            ))}
          </div>
          {preview.conflicts > 0 ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                setReplace(
                  Object.fromEntries(
                    parsed.candidates
                      .filter((entry) => conflict(entry))
                      .map((entry) => [entry.id, true]),
                  ),
                )
              }
            >
              Replace all conflicts
            </Button>
          ) : null}
          <p className="my-3 text-xs">
            {preview.additions} additions · {preview.conflicts} conflicts · {preview.skipped}{" "}
            skipped · resulting count: {preview.count}
          </p>
          {preview.validation ? (
            <p className="text-xs text-destructive">{preview.validation}</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            disabled={busy || !preview.imported || !!preview.validation}
            onClick={() => {
              setBusy(true);
              setError(null);
              void props
                .onImport(preview.next, props.version)
                .then(() => setOpen(false))
                .catch(async (cause) => {
                  setError(readErrorMessage(cause, "Import failed."));
                  // Refresh the base, retaining text, selections, and replacement decisions. Confirmation is required again.
                  await props.onRefreshBase().catch(() => undefined);
                })
                .finally(() => setBusy(false));
            }}
          >
            Import {preview.imported} into {props.scope}
          </Button>
        </DialogPopup>
      </Dialog>
    </>
  );
}
