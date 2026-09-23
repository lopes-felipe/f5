import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { GithubDeviceLogin } from "./GithubDeviceLogin";
import { ProfileGithubAccount, type GithubAccountRequest } from "./ProfileGithubAccount";

function setup() {
  vi.useFakeTimers();
  const values = new Map<string, Uint8Array>();
  const account = new ProfileGithubAccount(
    {
      get: (key) => Effect.succeed(values.get(key) ?? null),
      set: (key, value) =>
        Effect.sync(() => {
          values.set(key, value);
        }),
      remove: (key) =>
        Effect.sync(() => {
          values.delete(key);
        }),
      getOrCreateRandom: () => Effect.die("unused"),
    },
    async () => Response.json({ login: "octocat" }),
  );
  const request = vi.fn<GithubAccountRequest>().mockResolvedValueOnce(
    Response.json({
      device_code: "secret-device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_in: 60,
      interval: 1,
    }),
  );
  return { account, request, login: new GithubDeviceLogin(account, "f5-client", request) };
}
afterEach(() => vi.useRealTimers());

describe("GitHub device authorization", () => {
  it("polls pending and slowdown responses, saves identity, and never returns secrets", async () => {
    const { account, request, login } = setup();
    request
      .mockResolvedValueOnce(Response.json({ error: "authorization_pending" }))
      .mockResolvedValueOnce(Response.json({ error: "slow_down" }))
      .mockResolvedValueOnce(Response.json({ access_token: "private-token" }));
    const status = await login.start();
    expect(status.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(status)).not.toContain("secret-device-code");
    await vi.advanceTimersByTimeAsync(2000);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5999);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(login.status().state).toBe("connected");
    expect(login.status().login).toBe("octocat");
    expect(await account.token("github.com")).toBe("private-token");
    expect(JSON.stringify(login.status())).not.toContain("private-token");
    login.cancel();
  });

  it("does not save a token returned after cancellation", async () => {
    const { account, request, login } = setup();
    let finish!: (response: Response) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const attempt = await login.start();
    await vi.advanceTimersByTimeAsync(1000);
    login.cancel(attempt.handle);
    finish(Response.json({ access_token: "late-token" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await account.token("github.com")).toBeNull();
    expect(login.status().state).toBe("cancelled");
  });

  it.each(["access_denied", "expired_token"])(
    "handles %s without saving credentials",
    async (error) => {
      const { account, request, login } = setup();
      request.mockResolvedValueOnce(Response.json({ error }));
      await login.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(login.status().state).toBe(error === "expired_token" ? "expired" : "error");
      expect(await account.token("github.com")).toBeNull();
    },
  );

  it("bounds network retries by expiry and expires handles after restart", async () => {
    const { account, request, login } = setup();
    request.mockRejectedValue(new Error("network"));
    const attempt = await login.start();
    await vi.advanceTimersByTimeAsync(60000);
    expect(login.status().state).toBe("expired");
    expect(new GithubDeviceLogin(account, "client").status(attempt.handle).state).toBe("expired");
  });

  it("disables browser login without an app registration", async () => {
    const { account } = setup();
    const login = new GithubDeviceLogin(account, undefined);
    expect(login.status().available).toBe(false);
    await expect(login.start()).rejects.toThrow("not configured");
  });
});

it("saves an issued token even when verification crosses the device-code deadline", async () => {
  const { account, request, login } = setup();
  const save = account.set.bind(account);
  vi.spyOn(account, "set").mockImplementation(async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 61000));
    return save(...args);
  });
  request.mockResolvedValueOnce(Response.json({ access_token: "issued-before-expiry" }));
  await login.start();
  await vi.advanceTimersByTimeAsync(62000);
  expect(login.status().state).toBe("connected");
  expect(await account.token("github.com")).toBe("issued-before-expiry");
});
