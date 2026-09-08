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

export const useProfileState = create<{
  active: ProfileSummary | null;
  profiles: readonly ProfileSummary[];
  diagnostic: ProfileRegistryDiagnostic | undefined;
  mismatch: boolean;
}>(() => ({ active: null, profiles: [], diagnostic: undefined, mismatch: false }));
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
  if (!api) return;
  const result = await api.list();
  useProfileState.setState({
    profiles: result.profiles,
    diagnostic: result.diagnostic,
    active:
      result.profiles.find((profile) => profile.isActive) ?? useProfileState.getState().active,
  });
}
onProfilesUpdated((result) =>
  useProfileState.setState({
    profiles: result.profiles,
    diagnostic: result.diagnostic,
    active:
      result.profiles.find((profile) => profile.isActive) ?? useProfileState.getState().active,
  }),
);
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
