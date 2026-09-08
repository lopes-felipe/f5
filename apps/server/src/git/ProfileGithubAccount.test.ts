import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import { ProfileGithubAccount, type GithubAccountRequest } from "./ProfileGithubAccount";

function store(): ServerSecretStoreShape {
  const values = new Map<string, Uint8Array>();
  return {
    get: (key) => Effect.sync(() => values.get(key) ?? null),
    set: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    remove: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
    getOrCreateRandom: () => Effect.die("Unused"),
  };
}

describe("profile GitHub accounts", () => {
  it("verifies and rotates credentials independently for two profiles", async () => {
    const request = vi.fn<GithubAccountRequest>(async (_url, input) =>
      Response.json({
        login:
          new Headers(input?.headers).get("Authorization") === "Bearer work"
            ? "work-user"
            : "personal-user",
      }),
    );
    const work = new ProfileGithubAccount(store(), request);
    const personal = new ProfileGithubAccount(store(), request);
    expect(await work.token("github.com")).toBeNull();
    expect(await work.set("github.com", "work")).toEqual({ login: "work-user" });
    await personal.set("github.com", "personal");
    expect(await personal.status("github.com")).toEqual({ login: "personal-user" });
    await work.remove("github.com");
    expect(await work.status("github.com")).toEqual({ login: null });
    expect(await personal.token("github.com")).toBe("personal");
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("preserves the saved token when verification fails and rejects invalid hosts", async () => {
    const request = vi
      .fn<GithubAccountRequest>()
      .mockResolvedValueOnce(Response.json({ login: "work" }))
      .mockResolvedValueOnce(new Response("Denied", { status: 401 }));
    const account = new ProfileGithubAccount(store(), request);
    await account.set("git.example.com", "saved");
    await expect(account.set("git.example.com", "invalid")).rejects.toThrow("401");
    expect(await account.token("git.example.com")).toBe("saved");
    await expect(account.token("../elsewhere")).rejects.toThrow("Invalid GitHub hostname");
    expect(request).toHaveBeenCalledWith("https://git.example.com/api/v3/user", expect.anything());
  });
});
