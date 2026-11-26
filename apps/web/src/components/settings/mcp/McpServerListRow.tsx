import type { McpProjectServersConfig } from "@t3tools/contracts";
import { MoreHorizontalIcon } from "lucide-react";

import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { Switch } from "../../ui/switch";
import type { McpServerStatusSummary } from "./mcpServerStatus";

export interface McpRowAction {
  readonly label: string;
  readonly run: () => void;
  readonly destructive?: boolean;
}

/**
 * One configured server: name, transport, description, live status with its tool
 * count or failure reason, the enabled switch (or, for an inherited server, whether
 * this project uses it), and a menu of actions.
 */
export function McpServerListRow(props: {
  readonly name: string;
  readonly server: McpProjectServersConfig[string];
  readonly status: McpServerStatusSummary;
  readonly busy: boolean;
  readonly onOpen: () => void;
  /** The switch: Enabled for this scope's servers, Use in this project for inherited ones. */
  readonly switchLabel: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly actions: ReadonlyArray<McpRowAction | "separator">;
}) {
  const target = props.server.type === "stdio" ? props.server.command : props.server.url;
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" data-mcp-server={props.name}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
            aria-label={`Open ${props.name}`}
            onClick={props.onOpen}
          >
            {props.name}
          </button>
          <Badge variant="outline">{props.server.type}</Badge>
          <Badge
            variant={props.status.tone}
            title={props.status.source ? `Reported by ${props.status.source}` : undefined}
          >
            {props.status.label}
            {props.status.source ? ` · ${props.status.source}` : ""}
          </Badge>
        </div>
        {props.server.description ? (
          <p className="text-xs text-foreground">{props.server.description}</p>
        ) : null}
        <p className="truncate font-mono text-xs text-muted-foreground">{target}</p>
        {props.status.detail ? (
          <p
            className={
              props.status.tone === "error" || props.status.tone === "warning"
                ? "line-clamp-2 break-words text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {props.status.detail}
          </p>
        ) : null}
      </div>
      <Switch
        aria-label={props.switchLabel}
        checked={props.checked}
        disabled={props.busy}
        onCheckedChange={(checked) => props.onCheckedChange(Boolean(checked))}
      />
      <Menu>
        <MenuTrigger
          render={
            <Button aria-label={`Actions for ${props.name}`} size="icon-xs" variant="ghost" />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          {props.actions.map((action, index) =>
            action === "separator" ? (
              <MenuSeparator key={`separator-${index}`} />
            ) : (
              <MenuItem
                key={action.label}
                disabled={props.busy}
                variant={action.destructive ? "destructive" : "default"}
                onClick={action.run}
              >
                {action.label}
              </MenuItem>
            ),
          )}
        </MenuPopup>
      </Menu>
    </li>
  );
}
