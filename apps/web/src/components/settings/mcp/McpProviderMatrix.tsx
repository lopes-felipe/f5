import {
  PROVIDER_DISPLAY_NAMES,
  type McpServerDefinition,
  type ProviderKind,
} from "@t3tools/contracts";
import { mcpProviderMatrix } from "@t3tools/shared/mcpProviderSupport";

import { Badge } from "../../ui/badge";
import { Switch } from "../../ui/switch";

/**
 * Which providers get this server: Supported, Limited (with what they ignore), or
 * Off. The switches set `disabledProviders`; without `onToggle` the matrix is read-only.
 */
export function McpProviderMatrix(props: {
  readonly serverName: string;
  readonly server: McpServerDefinition;
  readonly disabled?: boolean;
  readonly onToggle?: ((provider: ProviderKind, enabled: boolean) => void) | undefined;
}) {
  return (
    <section aria-label="Providers" className="space-y-2 text-xs">
      <p className="font-medium text-foreground">Providers</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {mcpProviderMatrix(props.server).map((entry) => {
          const name = PROVIDER_DISPLAY_NAMES[entry.provider];
          return (
            <li key={entry.provider} className="flex items-start gap-2 px-2 py-1.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-foreground">{name}</span>
                  {entry.support === "supported" ? (
                    <Badge variant="success">Supported</Badge>
                  ) : entry.support === "limited" ? (
                    <Badge variant="warning">Limited</Badge>
                  ) : (
                    <Badge variant="outline">Off</Badge>
                  )}
                </div>
                {entry.reasons.map((reason) => (
                  <p key={reason} className="text-muted-foreground">
                    {reason}
                  </p>
                ))}
              </div>
              {props.onToggle ? (
                <Switch
                  aria-label={`Use ${props.serverName} with ${name}`}
                  checked={entry.support !== "off"}
                  disabled={props.disabled}
                  onCheckedChange={(checked) => props.onToggle?.(entry.provider, Boolean(checked))}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
