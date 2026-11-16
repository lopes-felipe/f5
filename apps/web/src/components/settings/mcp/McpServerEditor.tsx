import { McpArgumentFields } from "./McpArgumentFields";
import { readMcpKeyValueRows, mcpDuplicateKeys } from "./mcpEditorValues";
import { McpKeyValueFields } from "./McpKeyValueFields";
import { McpTestConnection } from "./McpTestConnection";
import { decodeDraftServer } from "./mcpDraft";
import { CODEX_SSE_TRANSPORT_HINT } from "@t3tools/shared/mcpTranslation";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import type { ServerDraft } from "./mcpDraft";

export function McpServerEditor({
  projectId,
  instanceId,
  editingServerName,
  draft,
  onDraftChange,
  onAdvancedDraftChange,
  formError,
  isAdvancedOpen,
  onAdvancedOpenChange,
  isSavingConfig,
  saveBlocked,
  beginCreate,
  saveDraft,
}: {
  readonly projectId: import("@t3tools/contracts").ProjectId | null;
  readonly instanceId: import("@t3tools/contracts").ProviderInstanceId;
  readonly editingServerName: string | null;
  readonly draft: ServerDraft;
  readonly onDraftChange: (patch: Partial<ServerDraft>) => void;
  readonly onAdvancedDraftChange: (patch: Partial<ServerDraft>) => void;
  readonly formError: string | null;
  readonly isAdvancedOpen: boolean;
  readonly onAdvancedOpenChange: (open: boolean) => void;
  readonly isSavingConfig: boolean;
  readonly saveBlocked: boolean;
  readonly beginCreate: () => void;
  readonly saveDraft: () => void;
}) {
  const duplicateKeys = mcpDuplicateKeys(
    readMcpKeyValueRows(draft.type === "stdio" ? draft.env : draft.headers),
  );
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">
            {editingServerName ? `Edit ${editingServerName}` : "Add MCP server"}
          </p>
          <p className="text-xs text-muted-foreground">
            Shared fields apply to Codex and Claude. Codex-only options stay saved in either scope.
          </p>
        </div>
        {editingServerName ? (
          <Button size="xs" variant="outline" onClick={beginCreate} disabled={isSavingConfig}>
            New server
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium text-foreground">Name</span>
          <Input
            value={draft.name}
            onChange={(event) => {
              onDraftChange({ name: event.target.value });
            }}
            placeholder="filesystem"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium text-foreground">Transport</span>
          <Select
            value={draft.type}
            onValueChange={(value) => {
              if (value !== "stdio" && value !== "sse" && value !== "http") {
                return;
              }
              onDraftChange({ type: value });
            }}
          >
            <SelectTrigger aria-label="MCP transport type">
              <SelectValue>{draft.type}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
              <SelectItem value="http">http</SelectItem>
            </SelectPopup>
          </Select>
        </label>
      </div>

      {draft.type === "sse" ? (
        <p className="text-xs text-muted-foreground">{CODEX_SSE_TRANSPORT_HINT}</p>
      ) : null}

      <div className="flex items-center justify-between rounded-lg border border-border/70 bg-card/40 px-3 py-3">
        <div className="space-y-1">
          <p className="text-xs font-medium text-foreground">Enabled</p>
          <p className="text-xs text-muted-foreground">
            Disabled servers stay saved but are excluded from provider startup.
          </p>
        </div>
        <Switch
          checked={draft.enabled}
          onCheckedChange={(checked) => {
            onDraftChange({ enabled: Boolean(checked) });
          }}
          aria-label="Enable MCP server"
        />
      </div>

      {draft.type === "stdio" ? (
        <div className="space-y-3">
          <label className="space-y-1">
            <span className="text-xs font-medium text-foreground">Command</span>
            <Input
              className="font-mono"
              value={draft.command}
              onChange={(event) => {
                onDraftChange({ command: event.target.value });
              }}
              placeholder="npx"
            />
          </label>
          <McpArgumentFields draft={draft} onChange={onDraftChange} />
          <div className="grid gap-3 sm:grid-cols-2">
            <McpKeyValueFields
              key={`${editingServerName}:${draft.original?.name}:env`}
              label="Environment"
              value={draft.env}
              onChange={(value) => onDraftChange({ env: value })}
            />
            <label className="space-y-1">
              <span className="text-xs font-medium text-foreground">Working directory</span>
              <Input
                className="font-mono"
                value={draft.cwd}
                onChange={(event) => {
                  onDraftChange({ cwd: event.target.value });
                }}
                placeholder="/path/to/project"
              />
            </label>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="space-y-1">
            <span className="text-xs font-medium text-foreground">URL</span>
            <Input
              className="font-mono"
              value={draft.url}
              onChange={(event) => {
                onDraftChange({ url: event.target.value });
              }}
              placeholder="https://example.com/mcp"
            />
          </label>
          <McpKeyValueFields
            key={`${editingServerName}:${draft.original?.name}:headers`}
            label="Headers"
            value={draft.headers}
            onChange={(value) => onDraftChange({ headers: value })}
          />
        </div>
      )}

      <Collapsible open={isAdvancedOpen} onOpenChange={onAdvancedOpenChange}>
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left">
          <span>
            <span className="block text-xs font-medium text-foreground">Advanced options</span>
            <span className="block text-xs text-muted-foreground">
              Tool timeout and tool filters apply to Codex and Claude. Other options apply to Codex.
            </span>
          </span>
          <Badge variant="outline">{isAdvancedOpen ? "Hide" : "Show"}</Badge>
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-3 space-y-3 rounded-lg border border-border/70 bg-card/40 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  Bearer token env var <Badge variant="outline">Codex only</Badge>
                </span>
                <Input
                  className="font-mono"
                  aria-label="Bearer token env var"
                  value={draft.bearerTokenEnvVar}
                  onChange={(event) =>
                    onAdvancedDraftChange({ bearerTokenEnvVar: event.target.value })
                  }
                  placeholder="MCP_AUTH_TOKEN"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  OAuth client ID <Badge variant="outline">Codex only</Badge>
                </span>
                <Input
                  className="font-mono"
                  aria-label="OAuth client ID"
                  value={draft.oauthClientId}
                  onChange={(event) => onAdvancedDraftChange({ oauthClientId: event.target.value })}
                  placeholder="client_id"
                />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  OAuth callback port <Badge variant="outline">Codex only</Badge>
                </span>
                <Input
                  className="font-mono"
                  aria-label="OAuth callback port"
                  value={draft.oauthCallbackPort}
                  onChange={(event) =>
                    onAdvancedDraftChange({ oauthCallbackPort: event.target.value })
                  }
                  placeholder="3118"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  OAuth callback URL <Badge variant="outline">Codex only</Badge>
                </span>
                <Input
                  aria-label="OAuth callback URL"
                  value={draft.oauthCallbackUrl}
                  onChange={(event) =>
                    onAdvancedDraftChange({ oauthCallbackUrl: event.target.value })
                  }
                  placeholder="http://127.0.0.1:3118/callback"
                />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  OAuth resource <Badge variant="outline">Codex only</Badge>
                </span>
                <Input
                  aria-label="OAuth resource"
                  value={draft.oauthResource}
                  onChange={(event) => onAdvancedDraftChange({ oauthResource: event.target.value })}
                  placeholder="https://example.com"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  Startup timeout (sec) <Badge variant="outline">Codex only</Badge>
                </span>
                <Input
                  aria-label="Startup timeout (sec)"
                  value={draft.startupTimeoutSec}
                  onChange={(event) =>
                    onAdvancedDraftChange({ startupTimeoutSec: event.target.value })
                  }
                  placeholder="30"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  Tool timeout (sec) <Badge variant="outline">Codex + Claude</Badge>
                </span>
                <Input
                  aria-label="Tool timeout (sec)"
                  value={draft.toolTimeoutSec}
                  onChange={(event) =>
                    onAdvancedDraftChange({ toolTimeoutSec: event.target.value })
                  }
                  placeholder="60"
                />
              </label>
            </div>

            <div className="flex items-center justify-between border-b border-border py-2 last:border-b-0">
              <div>
                <p className="text-xs font-medium text-foreground">
                  Parallel tool calls <Badge variant="outline">Codex only</Badge>
                </p>
                <p className="text-xs text-muted-foreground">
                  Declare that this server supports concurrent tool execution.
                </p>
              </div>
              <select
                value={draft.supportsParallelToolCalls}
                onChange={(event) =>
                  onAdvancedDraftChange({
                    supportsParallelToolCalls: event.target
                      .value as ServerDraft["supportsParallelToolCalls"],
                  })
                }
                aria-label="Supports parallel tool calls"
                className="rounded border border-border bg-background px-2 py-1 text-xs"
              >
                <option value="default">Default</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  Enabled tools <Badge variant="outline">Codex + Claude</Badge>
                </span>
                <Textarea
                  aria-label="Enabled tools"
                  value={draft.enabledTools}
                  onChange={(event) => onAdvancedDraftChange({ enabledTools: event.target.value })}
                  className="min-h-20"
                  placeholder="search&#10;read_file"
                />
                <span className="text-xs text-muted-foreground">
                  Leave empty to allow all tools.
                </span>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium text-foreground">
                  Disabled tools <Badge variant="outline">Codex + Claude</Badge>
                </span>
                <Textarea
                  aria-label="Disabled tools"
                  value={draft.disabledTools}
                  onChange={(event) => onAdvancedDraftChange({ disabledTools: event.target.value })}
                  className="min-h-20"
                  placeholder="dangerous_tool"
                />
              </label>
            </div>

            <label className="space-y-1">
              <span className="text-xs font-medium text-foreground">
                Scopes <Badge variant="outline">Codex only</Badge>
              </span>
              <Textarea
                aria-label="Scopes"
                value={draft.scopes}
                onChange={(event) => onAdvancedDraftChange({ scopes: event.target.value })}
                className="min-h-20"
                placeholder="read&#10;write"
              />
            </label>
          </div>
        </CollapsiblePanel>
      </Collapsible>

      <McpTestConnection
        projectId={projectId}
        instanceId={instanceId}
        getServer={() => decodeDraftServer(draft)}
      />
      <div className="flex items-center justify-between gap-3">
        {formError ? (
          <p className="text-xs text-destructive">{formError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Names are trimmed and capped at 128 characters. Saving replaces the full configuration
            for the selected scope.
          </p>
        )}
        <div className="flex items-center gap-2">
          {editingServerName ? (
            <Button size="sm" variant="outline" onClick={beginCreate} disabled={isSavingConfig}>
              Cancel
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={saveDraft}
            disabled={isSavingConfig || saveBlocked || duplicateKeys.size > 0}
          >
            {editingServerName ? "Save changes" : "Add server"}
          </Button>
        </div>
      </div>
    </div>
  );
}
