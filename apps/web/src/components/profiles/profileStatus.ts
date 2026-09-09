import type { ProfileSummary } from "@t3tools/contracts";

type ProfileStatusValue = ProfileSummary["status"];
type ProfileAccount = ProfileSummary["providerAccounts"][number];
type BadgeVariant = "success" | "warning" | "error" | "secondary" | "outline";

/**
 * Visual treatment for each profile lifecycle status. Centralized so the
 * settings card and the header switcher speak the same language, mirroring
 * `settings/providerStatus.ts`.
 *
 * Only design tokens are referenced here — never literal palette classes such
 * as `text-amber-600` — because `themePalette.ts` rewrites the token custom
 * properties at runtime for user themes.
 */
export const PROFILE_STATUS_STYLES = {
  ready: { dot: "bg-success", badge: "success", label: "Ready" },
  provisioning: { dot: "bg-warning", badge: "warning", label: "Setting up" },
  removing: { dot: "bg-destructive", badge: "error", label: "Removing" },
} as const satisfies Record<
  ProfileStatusValue,
  { readonly dot: string; readonly badge: BadgeVariant; readonly label: string }
>;

export interface ProfileStatusPresentation {
  readonly dot: string;
  readonly badge: BadgeVariant;
  readonly label: string;
  readonly detail: string | null;
  /** True while the server is still working on this profile. */
  readonly busy: boolean;
}

const STATUS_DETAIL: Record<ProfileStatusValue, string | null> = {
  ready: null,
  provisioning: "This profile is still being set up. It can be used once setup finishes.",
  removing: "This profile is being removed.",
};

export function profileStatusPresentation(profile: ProfileSummary): ProfileStatusPresentation {
  const style = PROFILE_STATUS_STYLES[profile.status];
  return {
    dot: style.dot,
    badge: style.badge,
    label: style.label,
    detail: STATUS_DETAIL[profile.status],
    busy: profile.status !== "ready",
  };
}

export interface ProfileAccountPresentation {
  readonly badge: BadgeVariant;
  readonly label: string;
  /** Identity when we have one, otherwise the server's reason, otherwise null. */
  readonly detail: string | null;
  /** False when the driver cannot be isolated per profile — no sign-in to offer. */
  readonly canSignIn: boolean;
}

export function profileAccountPresentation(account: ProfileAccount): ProfileAccountPresentation {
  const detail = account.identity ?? account.reason ?? null;
  switch (account.status) {
    case "authenticated":
      return { badge: "success", label: "Signed in", detail, canSignIn: true };
    case "unauthenticated":
      return { badge: "warning", label: "Not signed in", detail, canSignIn: true };
    case "unsupported-isolation":
      return { badge: "outline", label: "Not isolated", detail, canSignIn: false };
    default:
      return { badge: "secondary", label: "Unknown", detail, canSignIn: true };
  }
}

export interface ProfileWarning {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * Flatten the two optional warning arrays the server attaches to the active
 * profile into a single renderable list with user-facing copy.
 */
export function profileWarnings(profile: ProfileSummary): readonly ProfileWarning[] {
  const warnings: ProfileWarning[] = [];
  for (const entry of profile.invalidDirectories ?? []) {
    warnings.push({
      key: `directory:${entry.directory}`,
      title: "Project folder is unavailable",
      detail: `${entry.directory} — ${entry.reason} Update the project folder or worktree before running commands.`,
    });
  }
  for (const repository of profile.sharedRepositories ?? []) {
    warnings.push({
      key: `repository:${repository.workspaceRoot}`,
      title: "Shared Git checkout",
      detail: `${repository.workspaceRoot} shares Git metadata with ${repository.otherProfiles.join(", ")}. Changes here affect both profiles.`,
    });
  }
  return warnings;
}

/**
 * `ProfileRegistryStore.update` throws unless the record is `ready`, so edit
 * affordances must be disabled while a profile is provisioning or removing.
 */
export function isProfileEditable(profile: ProfileSummary): boolean {
  return profile.status === "ready";
}

export function profileLocationLabel(profile: ProfileSummary): string {
  return `localhost:${profile.port}`;
}

export const PROFILE_LAUNCH_COMMAND_PREFIX = "t3 --profile";

export function profileLaunchCommand(profile: ProfileSummary): string {
  return `${PROFILE_LAUNCH_COMMAND_PREFIX} ${profile.slug}`;
}

/**
 * Client-side port validation. Mirrors the rules the client can actually know:
 * integer, within range, and not already claimed by another profile in the
 * list. It deliberately cannot know `retiredPorts` or bindability — those stay
 * server-side and surface as an error string on Apply.
 *
 * Returns `null` when valid, otherwise a user-facing message.
 */
export function validateProfilePort(
  raw: string,
  profiles: readonly ProfileSummary[],
  selfId: ProfileSummary["id"],
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "Port is required.";
  if (!/^\d+$/.test(trimmed)) return "Port must be a whole number.";
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "Port must be between 1 and 65535.";
  }
  const clash = profiles.find((profile) => profile.id !== selfId && profile.port === port);
  if (clash) return `Port ${port} is already used by ${clash.name}.`;
  return null;
}

/**
 * Reimplements the server's slug derivation (`ProfileRegistryStore.create`) so
 * the create dialog can preview the launch command. Presented to the user as a
 * preview, never as a promise — the server remains authoritative.
 */
export function previewProfileSlug(name: string, takenSlugs: readonly string[]): string {
  let stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 26);
  if (!/^[a-z]/.test(stem)) stem = `profile-${stem}`.slice(0, 26);
  let slug = stem;
  for (let suffix = 2; takenSlugs.includes(slug); suffix++) slug = `${stem}-${suffix}`;
  return slug;
}

/** Active profile first, then registry order. */
export function orderProfiles(profiles: readonly ProfileSummary[]): readonly ProfileSummary[] {
  if (profiles.length < 2) return profiles;
  const active = profiles.filter((profile) => profile.isActive);
  if (active.length === 0) return profiles;
  return [...active, ...profiles.filter((profile) => !profile.isActive)];
}
