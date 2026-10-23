import { useEffect, useState } from "react";
import type { DesktopCliCommandState } from "@t3tools/contracts";
import { Button } from "../ui/button";

export function CliCommandSettings() {
  const bridge = window.desktopBridge?.cliCommand;
  const [state, setState] = useState<DesktopCliCommandState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (bridge)
      void bridge
        .state()
        .then((next) => {
          if (active) setState(next);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [bridge]);
  if (!bridge || !state?.supported) return null;
  const installed = state.installedPaths.f5 && state.installedPaths.t3;
  return (
    <div className="border-b border-border py-3" data-settings-search-target="about.cli">
      <p className="text-sm font-medium">Command-line tools</p>
      <p className="mt-1 text-xs text-muted-foreground" role="status">
        {state.shadowedBy
          ? `Another command at ${state.shadowedBy} runs first on PATH. Remove it or adjust PATH before installing.`
          : installed
            ? state.onPath
              ? "f5 and t3 are installed. Open a new terminal to use them."
              : `Installed at ${state.installedPaths.f5} and ${state.installedPaths.t3}. Add their directories to PATH to use them.`
            : "Install the bundled f5 and t3 commands in /usr/local/bin or ~/.local/bin."}
      </p>
      {error ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        className="mt-2"
        size="xs"
        variant="outline"
        disabled={pending || Boolean(state.shadowedBy)}
        onClick={() => {
          setPending(true);
          setError(null);
          void bridge
            .install()
            .then(setState)
            .catch(async (cause) => {
              setError(
                cause instanceof Error ? cause.message : "Could not install the CLI commands.",
              );
              await bridge
                .state()
                .then(setState)
                .catch(() => {});
            })
            .finally(() => setPending(false));
        }}
      >
        {pending ? "Installing…" : installed ? "Check installation" : "Install CLI commands"}
      </Button>
    </div>
  );
}
