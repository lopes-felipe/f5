import type { ProfileSummary } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { updateProfile } from "../../profileActions";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { validateProfilePort } from "./profileStatus";

/**
 * Port editor with an explicit Apply.
 *
 * Unlike name and accent, a port change is irreversible: the registry pushes
 * the previous port onto `retiredPorts` and refuses to reuse it, the new port
 * is bind-checked server-side, and the running server keeps listening on the
 * old port until restarted. Committing that on blur would burn a port on a
 * stray keystroke, so it stays behind a deliberate action.
 */
export function ProfilePortField({
  profile,
  profiles,
  disabled,
}: {
  readonly profile: ProfileSummary;
  readonly profiles: readonly ProfileSummary[];
  readonly disabled: boolean;
}) {
  const serverPort = String(profile.port);
  const [draft, setDraft] = useState(serverPort);
  const [isDirty, setIsDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resync from the server only when there is nothing local to lose.
  useEffect(() => {
    if (isDirty || pending) return;
    setDraft(serverPort);
    setError(null);
  }, [isDirty, pending, serverPort]);

  const validationError = isDirty ? validateProfilePort(draft, profiles, profile.id) : null;
  const canApply = isDirty && !pending && !disabled && validationError === null;

  const reset = () => {
    setIsDirty(false);
    setDraft(serverPort);
    setError(null);
  };

  const apply = () => {
    if (!canApply) return;
    setPending(true);
    setError(null);
    void updateProfile(profile, { port: Number(draft.trim()) })
      .then(() => setIsDirty(false))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };

  const message = validationError ?? error;

  return (
    <div className="grid gap-2">
      <label htmlFor={`profile-${profile.id}-port`} className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Port</span>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`profile-${profile.id}-port`}
            className="w-32"
            inputMode="numeric"
            value={draft}
            disabled={disabled || pending}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? `profile-${profile.id}-port-error` : undefined}
            onChange={(event) => {
              setIsDirty(true);
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                apply();
              } else if (event.key === "Escape") {
                event.preventDefault();
                reset();
              }
            }}
          />
          {isDirty ? (
            <>
              <Button size="xs" disabled={!canApply} onClick={apply}>
                {pending ? <Spinner className="size-3" /> : null}
                Apply
              </Button>
              <Button size="xs" variant="ghost" disabled={pending} onClick={reset}>
                Reset
              </Button>
            </>
          ) : null}
        </div>
      </label>
      {message ? (
        <span
          id={`profile-${profile.id}-port-error`}
          role="alert"
          className="text-[11px] text-destructive"
        >
          {message}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          Restart this profile for the new port to take effect. The current port is retired and
          cannot be reused.
        </span>
      )}
    </div>
  );
}
