import type { ProfileSummary } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { createProfile } from "../../profileActions";
import { PROVIDER_ACCENT_SWATCHES } from "../../providerInstances";
import { AccentColorPicker } from "../settings/AccentColorPicker";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { previewProfileSlug } from "./profileStatus";

const MAX_NAME_LENGTH = 64;

export function ProfileCreateDialog({
  open,
  onOpenChange,
  profiles,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly profiles: readonly ProfileSummary[];
}) {
  const [name, setName] = useState("");
  const [accentColor, setAccentColor] = useState<string>(PROVIDER_ACCENT_SWATCHES[0]);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setAccentColor(PROVIDER_ACCENT_SWATCHES[0]);
    setSubmitted(false);
    setPending(false);
    setError(null);
  }, [open]);

  const trimmed = name.trim();
  const slug = previewProfileSlug(
    trimmed,
    profiles.map((profile) => profile.slug),
  );

  const nameError =
    trimmed.length === 0
      ? "Name is required."
      : trimmed.length > MAX_NAME_LENGTH
        ? `Name must be ${MAX_NAME_LENGTH} characters or fewer.`
        : profiles.some((profile) => profile.name.toLowerCase() === trimmed.toLowerCase())
          ? `A profile named “${trimmed}” already exists.`
          : slug.length === 0
            ? "Use at least one letter or number."
            : null;
  const showNameError = submitted && nameError !== null;

  const submit = () => {
    setSubmitted(true);
    if (nameError !== null || pending) return;
    setPending(true);
    setError(null);
    void createProfile({ name: trimmed, accentColor })
      .then(() => {
        toastManager.add({
          type: "success",
          title: "Profile created",
          description: `${trimmed} is being set up.`,
        });
        onOpenChange(false);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>New profile</DialogTitle>
          <DialogDescription>
            A profile gets its own accounts, projects, chat history, and settings, plus its own
            port.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <form
            id="profile-create-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label htmlFor="profile-create-name" className="grid gap-2">
              <span className="text-xs font-medium text-foreground">Name</span>
              <Input
                id="profile-create-name"
                autoFocus
                className="bg-background"
                placeholder="Work"
                value={name}
                spellCheck={false}
                disabled={pending}
                aria-invalid={showNameError ? true : undefined}
                onChange={(event) => setName(event.target.value)}
              />
              {showNameError ? (
                <span className="text-[11px] text-destructive">{nameError}</span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  Launch command preview:{" "}
                  <code className="rounded bg-muted/60 px-1 py-0.5">
                    t3 --profile {trimmed.length === 0 ? "…" : slug}
                  </code>
                </span>
              )}
            </label>

            <AccentColorPicker
              ariaLabel="Accent color for the new profile"
              description="Used to tell this profile apart in the switcher."
              value={accentColor}
              allowClear={false}
              disabled={pending}
              onCommit={(next) => {
                if (next) setAccentColor(next);
              }}
            />

            <p className="text-[11px] text-muted-foreground">
              A free port is assigned automatically.
            </p>
          </form>

          {error ? (
            <Alert variant="error" className="text-xs">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="profile-create-form" disabled={pending}>
            {pending ? <Spinner className="size-3" /> : null}
            Create profile
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
