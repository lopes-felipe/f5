import type { ProfileSummary } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { PROVIDER_ACCENT_SWATCHES } from "../../providerInstances";
import { profileStatusPresentation } from "./profileStatus";

/**
 * The visual identity of a profile: an accent chip carrying a status dot.
 * Single source of truth so the settings card, the switcher rows and the
 * switcher trigger cannot drift apart.
 */
export function ProfileAvatar({
  profile,
  size = "md",
  className,
}: {
  readonly profile: Pick<ProfileSummary, "accentColor" | "status" | "name">;
  readonly size?: "sm" | "md";
  readonly className?: string;
}) {
  const status = profileStatusPresentation(profile as ProfileSummary);
  const accent = profile.accentColor ?? PROVIDER_ACCENT_SWATCHES[0];
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0",
        size === "sm" ? "size-3.5" : "size-4",
        className,
      )}
      aria-hidden
    >
      <span
        className="size-full rounded-full border border-black/10 dark:border-white/20"
        style={{ backgroundColor: accent }}
      />
      {status.busy ? (
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card",
            status.dot,
          )}
        />
      ) : null}
    </span>
  );
}
