import { WS_METHODS, type ProfileRecord } from "@t3tools/contracts";
import { profileStateDir } from "@t3tools/shared/profilePaths";
import { Effect, Struct } from "effect";

import type { ProfileRegistryStore } from "../../profiles/ProfileRegistryStore.ts";
import { routePromise, type RouteTable } from "./routeTable.ts";

type ProfileMethod =
  | typeof WS_METHODS.profilesList
  | typeof WS_METHODS.profilesCreate
  | typeof WS_METHODS.profilesUpdate
  | typeof WS_METHODS.profilesDelete;

export interface ProfileRouteDependencies {
  readonly store: Pick<ProfileRegistryStore, "create" | "update" | "remove">;
  /** Every profile, with what only the running one knows (accounts, warnings). */
  readonly list: () => Promise<unknown>;
  /** The Default profile's state directory; the others live beside it. */
  readonly defaultStateDir: string;
  /** The profile this server runs as. */
  readonly activeProfileId: string;
  /**
   * Set when this server may only list profiles (a Linux VM guest): creating, changing and
   * deleting fail with this message, before the store is touched.
   */
  readonly mutationRefusal?: string;
}

/** The profiles on this machine: listing them, and creating, changing and deleting one. */
export const profileRoutes = ({
  store,
  list,
  defaultStateDir,
  activeProfileId,
  mutationRefusal,
}: ProfileRouteDependencies): RouteTable<ProfileMethod> => {
  const mutate = <A>(run: () => Promise<A>) =>
    routePromise(() =>
      mutationRefusal === undefined ? run() : Promise.reject(new Error(mutationRefusal)),
    );
  // A created or changed profile is answered without its provider accounts:
  // only the server running as a profile can read them, and the list fills
  // them in for the active one.
  const answer = (profile: ProfileRecord) => ({
    ...profile,
    stateDir: profileStateDir(defaultStateDir, profile),
    isActive: profile.id === activeProfileId,
    providerAccounts: [],
  });
  return {
    [WS_METHODS.profilesList]: () => routePromise(list),
    [WS_METHODS.profilesCreate]: (body) =>
      mutate(() => store.create(Struct.omit(body, ["_tag"]))).pipe(Effect.map(answer)),
    [WS_METHODS.profilesUpdate]: (body) =>
      mutate(() => store.update(Struct.omit(body, ["_tag"]))).pipe(Effect.map(answer)),
    [WS_METHODS.profilesDelete]: ({ profileId }) => mutate(() => store.remove(profileId)),
  };
};
