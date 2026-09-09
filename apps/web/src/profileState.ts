import { profileProviderAccounts } from "@t3tools/shared/profileProviderAccounts";
import { create } from "zustand";
import type {
  ProfileSummary,
  ServerProvider,
  ProfileRegistryDiagnostic,
  WsWelcomePayload,
} from "@t3tools/contracts";
import { ensureNativeApi } from "./nativeApi";
import { onProfilesUpdated } from "./wsNativeApi";

export type ProfileLoadState = "idle" | "loading" | "ready" | "error" | "unsupported";

export const useProfileState = create<{
  active: ProfileSummary | null;
  profiles: readonly ProfileSummary[];
  diagnostic: ProfileRegistryDiagnostic | undefined;
  mismatch: boolean;
  loadState: ProfileLoadState;
  loadError: string | null;
  /** True while a refresh is in flight that should not collapse the list. */
  isRefreshing: boolean;
}>(() => ({
  active: null,
  profiles: [],
  diagnostic: undefined,
  mismatch: false,
  loadState: "idle",
  loadError: null,
  isRefreshing: false,
}));

type ProfilePatch = Partial<Pick<ProfileSummary, "name" | "port" | "accentColor">>;

const PATCH_TTL_MS = 15_000;
const pendingPatches = new Map<string, { patch: ProfilePatch; expiresAt: number }>();

/**
 * Record a field-level write the server has already accepted.
 *
 * `readProfiles()` on the server caches for 2000 ms, so a refresh issued right
 * after a successful mutation can legitimately return the pre-edit snapshot.
 * The per-field focus guards cannot help there — the input is no longer focused
 * by then — so the value would visibly flash back. Holding the accepted patch
 * until the server echoes it keeps the UI honest without any optimistic lying:
 * nothing is recorded unless the write succeeded.
 */
export function recordProfilePatch(profileId: string, patch: ProfilePatch): void {
  if (Object.keys(patch).length === 0) return;
  const existing = pendingPatches.get(profileId);
  pendingPatches.set(profileId, {
    patch: { ...existing?.patch, ...patch },
    expiresAt: Date.now() + PATCH_TTL_MS,
  });
}

/** Test seam: drop every pending patch. */
export function clearProfilePatches(): void {
  pendingPatches.clear();
}

/**
 * Apply still-unsettled local commits on top of a server snapshot. A patch
 * clears the moment the server echoes the value back, and is bounded by a TTL
 * so a dropped push can never pin a stale value forever.
 *
 * Exported for tests.
 */
export function reconcileProfiles(
  snapshot: readonly ProfileSummary[],
  now: number = Date.now(),
): readonly ProfileSummary[] {
  if (pendingPatches.size === 0) return snapshot;
  return snapshot.map((profile) => {
    const entry = pendingPatches.get(profile.id);
    if (!entry) return profile;
    const settled = Object.entries(entry.patch).every(
      ([key, value]) => profile[key as keyof ProfileSummary] === value,
    );
    if (settled || entry.expiresAt <= now) {
      pendingPatches.delete(profile.id);
      return profile;
    }
    return { ...profile, ...entry.patch };
  });
}

function acceptSnapshot(result: {
  readonly profiles: readonly ProfileSummary[];
  readonly diagnostic?: ProfileRegistryDiagnostic | undefined;
}) {
  const profiles = reconcileProfiles(result.profiles);
  useProfileState.setState({
    profiles,
    diagnostic: result.diagnostic,
    active: profiles.find((profile) => profile.isActive) ?? useProfileState.getState().active,
    loadState: "ready",
    loadError: null,
  });
}

export function acceptProfileWelcome(payload: WsWelcomePayload): boolean {
  if (!payload.profile) return true;
  const expected = window.desktopBridge?.getProfileId?.() ?? useProfileState.getState().active?.id;
  if (expected && expected !== payload.profile.id) {
    useProfileState.setState({ mismatch: true });
    return false;
  }
  useProfileState.setState({ active: payload.profile, diagnostic: payload.profileDiagnostic });
  void refreshProfiles().catch(() => {});
  return true;
}

export async function refreshProfiles() {
  const api = ensureNativeApi().profiles;
  if (!api) {
    useProfileState.setState({ loadState: "unsupported", loadError: null, isRefreshing: false });
    return;
  }
  // Only show the skeleton on a genuine first load; a background refresh must
  // never collapse a list the user is already reading.
  const isFirstLoad = useProfileState.getState().profiles.length === 0;
  useProfileState.setState({
    isRefreshing: true,
    ...(isFirstLoad ? { loadState: "loading" as const } : {}),
  });
  try {
    acceptSnapshot(await api.list());
  } catch (cause) {
    useProfileState.setState({
      loadState: "error",
      loadError: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  } finally {
    useProfileState.setState({ isRefreshing: false });
  }
}

onProfilesUpdated((result) => acceptSnapshot(result));

export function profileBrowserUrl(
  profile: Pick<ProfileSummary, "port">,
  location: Pick<Location, "protocol" | "hostname"> = window.location,
): string {
  const host =
    location.hostname.includes(":") && !location.hostname.startsWith("[")
      ? `[${location.hostname}]`
      : location.hostname;
  return `${location.protocol}//${host}:${profile.port}/`;
}

export function updateProfileAccounts(providers: readonly ServerProvider[]) {
  const active = useProfileState.getState().active;
  if (!active) return;
  const updated = { ...active, providerAccounts: profileProviderAccounts(providers) };
  useProfileState.setState((state) => ({
    active: updated,
    profiles: state.profiles.map((profile) => (profile.id === active.id ? updated : profile)),
  }));
}
