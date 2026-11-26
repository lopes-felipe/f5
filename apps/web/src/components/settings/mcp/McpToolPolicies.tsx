import type { McpServerDefinition, McpToolPin, McpToolPolicy } from "@t3tools/contracts";
import { setMcpDefaultToolPolicy, type McpToolPolicyChoice } from "@t3tools/shared/mcpTools";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ensureNativeApi } from "../../../nativeApi";
import { mcpQueryKeys, mcpToolPinsQueryOptions } from "../../../lib/mcpReactQuery";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { toastManager } from "../../ui/toast";
import { readErrorMessage } from "./mcpSettingsHelpers";

const CHOICE_LABELS: Record<McpToolPolicyChoice, string> = {
  allow: "Allow",
  ask: "Ask",
  block: "Block",
};

/** Allow, Ask or Block for one tool. */
export function McpToolPolicyToggle(props: {
  readonly toolName: string;
  readonly value: McpToolPolicyChoice;
  /** The allowlist excludes the tool; it stays blocked until the list changes. */
  readonly excluded?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (choice: McpToolPolicyChoice) => void;
}) {
  return (
    <ToggleGroup
      variant="outline"
      size="xs"
      aria-label={`Policy for ${props.toolName}`}
      value={[props.value]}
      disabled={props.disabled || props.excluded}
      onValueChange={(value) => {
        const next = value[0] as McpToolPolicyChoice | undefined;
        if (next && next !== props.value) props.onChange(next);
      }}
    >
      {(["allow", "ask", "block"] as const).map((choice) => (
        <Toggle key={choice} value={choice}>
          {CHOICE_LABELS[choice]}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export function McpToolPinBadge(props: { readonly state: McpToolPin["state"] | undefined }) {
  if (props.state === "changed")
    return (
      <Badge variant="warning" size="sm">
        Changed
      </Badge>
    );
  if (props.state === "new")
    return (
      <Badge variant="info" size="sm">
        New
      </Badge>
    );
  return null;
}

/** Tool name → pin state, for the tool list. */
export function useMcpToolPins(serverName: string) {
  const query = useQuery(mcpToolPinsQueryOptions({ serverName }));
  const pins = query.data?.tools ?? [];
  return {
    pins,
    states: new Map(pins.map((pin) => [pin.toolName, pin.state] as const)),
  };
}

/**
 * The Tools tab's header: the policy for tools without their own setting, and the
 * tools whose definition changed (or appeared) since they were last reviewed.
 */
export function McpToolPolicies(props: {
  readonly serverName: string;
  readonly server: McpServerDefinition;
  readonly editable: boolean;
  readonly onServerChange: (next: McpServerDefinition) => Promise<void>;
  readonly pins: ReadonlyArray<McpToolPin>;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultPolicy: McpToolPolicy = props.server.defaultToolPolicy ?? "allow";
  const review = props.pins.filter((pin) => pin.state !== "pinned");

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(readErrorMessage(cause, fallback));
    } finally {
      setBusy(false);
    }
  };

  // Sends the definitions shown, so a tool that changed again since is not accepted.
  const accept = (pins: ReadonlyArray<McpToolPin>) =>
    run(async () => {
      const identity = pins[0]?.identity;
      if (!identity) return;
      const result = await ensureNativeApi().mcp.acceptToolChanges({
        serverName: props.serverName,
        identity,
        reviewed: pins.map((pin) => ({
          toolName: pin.toolName,
          definition: pin.observed ?? pin.accepted,
        })),
      });
      await queryClient.invalidateQueries({ queryKey: mcpQueryKeys.toolPins(props.serverName) });
      if (result.stale)
        toastManager.add({
          type: "warning",
          title:
            result.stale === 1
              ? "A tool changed again before you accepted it. Review it again."
              : `${result.stale} tools changed again before you accepted them. Review them again.`,
        });
    }, "Could not accept the tool changes.");

  return (
    <section aria-label="Tool policy" className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-foreground">Tools without their own setting</p>
          <p className="text-muted-foreground">
            Ask shows an approval in the conversation before each call, for every agent and mode.
          </p>
        </div>
        <ToggleGroup
          variant="outline"
          size="xs"
          aria-label="Default tool policy"
          value={[defaultPolicy]}
          disabled={!props.editable || busy}
          onValueChange={(value) => {
            const next = value[0] as McpToolPolicy | undefined;
            if (!next || next === defaultPolicy) return;
            void run(
              () => props.onServerChange(setMcpDefaultToolPolicy(props.server, next)),
              "Could not save the tool policy.",
            );
          }}
        >
          <Toggle value="allow">Allow</Toggle>
          <Toggle value="ask">Ask</Toggle>
        </ToggleGroup>
      </div>

      {review.length > 0 ? (
        <div role="region" aria-label="Tools to review" className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-foreground">
              {review.length === 1 ? "1 tool needs review." : `${review.length} tools need review.`}{" "}
              A changed tool asks before every call until you accept the change.
            </p>
            {[...new Set(review.map((pin) => pin.identity))].map((identity) => (
              <Button
                key={identity}
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void accept(review.filter((pin) => pin.identity === identity))}
              >
                Accept all
              </Button>
            ))}
          </div>
          {review.map((pin) => (
            <div
              key={`${pin.identity}:${pin.toolName}`}
              className="space-y-1 rounded-md border border-border p-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-foreground">{pin.toolName}</span>
                  <McpToolPinBadge state={pin.state} />
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void accept([pin])}
                >
                  {pin.state === "changed" ? "Accept change" : "Mark reviewed"}
                </Button>
              </div>
              {pin.state === "changed" && pin.observed ? (
                <div className="grid gap-2 md:grid-cols-2">
                  <div>
                    <p className="text-muted-foreground">Accepted</p>
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-1.5">
                      {pin.accepted}
                    </pre>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Now</p>
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-1.5">
                      {pin.observed}
                    </pre>
                  </div>
                </div>
              ) : null}
              {new Set(props.pins.map((entry) => entry.identity)).size > 1 ? (
                <p className="text-muted-foreground">{pin.identityLabel}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
