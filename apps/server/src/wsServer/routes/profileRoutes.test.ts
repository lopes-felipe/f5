import { ProfileId, WS_METHODS, type ProfileRecord } from "@t3tools/contracts";
import { profileStateDir } from "@t3tools/shared/profilePaths";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";

import { profileRoutes } from "./profileRoutes.ts";
import { answerFromTable, tableAnswers, type RouteBody } from "./routeTable.ts";

const socket = {} as unknown as WebSocket;
const defaultStateDir = "/home/me/.f5/userdata";
const profileId = Schema.decodeUnknownSync(ProfileId);
const activeId = profileId("a".repeat(32));
const otherId = profileId("b".repeat(32));

const record = (id: ProfileId, name: string): ProfileRecord => ({
  id,
  slug: name.toLowerCase(),
  name,
  port: 3780,
  isDefault: false,
  status: "ready",
  createdAt: "2026-11-14T00:00:00.000Z",
});

const makeRoutes = () => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const routes = profileRoutes({
    store: {
      create: async (input) => {
        calls.push(["create", input]);
        return record(otherId, input.name);
      },
      update: async (input) => {
        calls.push(["update", input]);
        return record(input.profileId, input.name ?? "Work");
      },
      remove: async (profileId) => {
        calls.push(["remove", profileId]);
        if (profileId === activeId) throw new Error("The running profile cannot be deleted.");
      },
    },
    list: async () => ({ profiles: ["every profile"] }),
    defaultStateDir,
    activeProfileId: activeId,
  });
  const answer = (body: RouteBody) => {
    if (!tableAnswers(routes, body)) throw new Error(`${body._tag} is not a profile route`);
    return Effect.runPromise(
      answerFromTable(routes, body, socket).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: (value) => ({ value }) }),
      ),
    );
  };
  return { calls, answer };
};

it("answers the list as the server read it", async () => {
  const { answer } = makeRoutes();
  await expect(answer({ _tag: WS_METHODS.profilesList })).resolves.toEqual({
    value: { profiles: ["every profile"] },
  });
});

it("creates a profile and answers where it lives, with no accounts and not active", async () => {
  const { calls, answer } = makeRoutes();
  const answered = await answer({
    _tag: WS_METHODS.profilesCreate,
    name: "Side",
    accentColor: "#112233",
  });
  expect(calls).toEqual([["create", { name: "Side", accentColor: "#112233" }]]);
  expect(answered).toEqual({
    value: {
      ...record(otherId, "Side"),
      stateDir: profileStateDir(defaultStateDir, { id: otherId, isDefault: false }),
      isActive: false,
      providerAccounts: [],
    },
  });
});

it("marks a changed profile active only when this server runs as it", async () => {
  const { calls, answer } = makeRoutes();
  const active = await answer({
    _tag: WS_METHODS.profilesUpdate,
    profileId: activeId,
    name: "Work",
    accentColor: undefined,
  });
  const other = await answer({
    _tag: WS_METHODS.profilesUpdate,
    profileId: otherId,
    accentColor: "#445566",
    port: 3791,
  });
  expect(calls).toEqual([
    ["update", { profileId: activeId, name: "Work", accentColor: undefined }],
    ["update", { profileId: otherId, accentColor: "#445566", port: 3791 }],
  ]);
  expect(active).toMatchObject({ value: { id: activeId, isActive: true, providerAccounts: [] } });
  expect(other).toMatchObject({ value: { id: otherId, isActive: false, providerAccounts: [] } });
});

it("deletes the profile it was asked to, and answers a refusal with its message", async () => {
  const { calls, answer } = makeRoutes();
  await expect(answer({ _tag: WS_METHODS.profilesDelete, profileId: otherId })).resolves.toEqual({
    value: undefined,
  });
  const refused = await answer({ _tag: WS_METHODS.profilesDelete, profileId: activeId });
  expect(calls).toEqual([
    ["remove", otherId],
    ["remove", activeId],
  ]);
  expect(refused).toMatchObject({
    error: { _tag: "RouteRequestError", message: "The running profile cannot be deleted." },
  });
});
