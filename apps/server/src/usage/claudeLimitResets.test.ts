import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_KEYCHAIN_BLOCKED_MESSAGE,
  CLAUDE_LIMIT_RESET_STATUS_PATH,
  CLAUDE_SIGN_IN_AGAIN_MESSAGE,
  ClaudeLimitResetRequestError,
  SecurityCommandError,
  claudeCredentialsAccount,
  claudeCredentialsService,
  makeClaudeLimitResetClient,
  mapClaudeClaimResult,
  normalizeClaudeLimitResets,
  parseClaudeCredentials,
  readClaudeOAuthToken,
  type ClaudeTokenRead,
  type ClaudeTokenSource,
} from "./claudeLimitResets.ts";

const SECRET = "sk-ant-oat01-secret-token";
const NOW = Date.parse("2026-11-14T19:00:00.000Z");
const credentials = (accessToken = SECRET, expiresAt: number | null = NOW + 3_600_000) =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, refreshToken: "refresh" } });

describe("Claude credential location", () => {
  it("matches Claude Code's secure-storage service names", () => {
    const dir = "/Users/me/.f5/provider-homes/claude/.claude";
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    expect(claudeCredentialsService({ CLAUDE_CONFIG_DIR: dir }, dir)).toBe(
      `Claude Code-credentials-${hash}`,
    );
    expect(claudeCredentialsService({}, "/Users/me/.claude")).toBe("Claude Code-credentials");
    // An explicit secure-storage dir wins, and an empty one means the default store.
    expect(
      claudeCredentialsService(
        { CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: "" },
        dir,
      ),
    ).toBe("Claude Code-credentials");
    expect(claudeCredentialsService({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/x" }, dir)).toBe(
      `Claude Code-credentials-${createHash("sha256").update("/x").digest("hex").slice(0, 8)}`,
    );
  });

  it("hashes the NFC form of the config dir", () => {
    const decomposed = "/Users/josé/.claude";
    const composed = decomposed.normalize("NFC");
    expect(claudeCredentialsService({ CLAUDE_CONFIG_DIR: decomposed }, decomposed)).toBe(
      claudeCredentialsService({ CLAUDE_CONFIG_DIR: composed }, composed),
    );
  });

  it("uses $USER and falls back to a fixed account for unusable names", () => {
    expect(claudeCredentialsAccount({ USER: "felipe" }, "other")).toBe("felipe");
    expect(claudeCredentialsAccount({}, "fallback")).toBe("fallback");
    expect(claudeCredentialsAccount({ USER: "has space" }, "x")).toBe("claude-code-user");
  });
});

describe("readClaudeOAuthToken", () => {
  const source = (overrides: Partial<ClaudeTokenSource>): ClaudeTokenSource => ({
    configDir: "/cfg",
    env: { CLAUDE_CONFIG_DIR: "/cfg", USER: "me" },
    platform: "darwin",
    fallbackUser: "me",
    runSecurity: () => Promise.reject(new SecurityCommandError(44)),
    readFile: () => Promise.reject(new Error("missing")),
    ...overrides,
  });

  it("reads the Keychain first on macOS", async () => {
    const runSecurity = vi.fn(async () => `${credentials()}\n`);
    const readFile = vi.fn(async () => credentials("file-token"));
    const read = await readClaudeOAuthToken(source({ runSecurity, readFile }));
    expect(read).toEqual({
      kind: "token",
      token: { accessToken: SECRET, expiresAt: NOW + 3_600_000 },
    });
    expect(runSecurity).toHaveBeenCalledWith([
      "find-generic-password",
      "-a",
      "me",
      "-w",
      "-s",
      claudeCredentialsService({ CLAUDE_CONFIG_DIR: "/cfg" }, "/cfg"),
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back to .credentials.json, and reads only the file elsewhere", async () => {
    const readFile = vi.fn(async () => credentials("file-token"));
    expect(await readClaudeOAuthToken(source({ readFile }))).toMatchObject({
      kind: "token",
      token: { accessToken: "file-token" },
    });
    expect(readFile).toHaveBeenCalledWith("/cfg/.credentials.json");
    const runSecurity = vi.fn(async () => credentials());
    expect(
      await readClaudeOAuthToken(source({ platform: "linux", runSecurity, readFile })),
    ).toMatchObject({ token: { accessToken: "file-token" } });
    expect(runSecurity).not.toHaveBeenCalled();
  });

  it("decodes hex-encoded Keychain payloads", async () => {
    const hex = Buffer.from(credentials(), "utf8").toString("hex");
    expect(await readClaudeOAuthToken(source({ runSecurity: async () => hex }))).toMatchObject({
      token: { accessToken: SECRET },
    });
  });

  it("reports missing and unsupported stores", async () => {
    expect(await readClaudeOAuthToken(source({}))).toEqual({ kind: "missing" });
    expect(await readClaudeOAuthToken(source({ runSecurity: async () => "not json" }))).toEqual({
      kind: "missing",
    });
    expect(await readClaudeOAuthToken(source({ customEndpoint: true }))).toEqual({
      kind: "unsupported",
    });
    expect(
      await readClaudeOAuthToken(
        source({
          env: { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://x" },
          runSecurity: async () => credentials(),
        }),
      ),
    ).toEqual({ kind: "unsupported" });
  });

  it("tells a missing Keychain item from a refused or timed-out read", async () => {
    const failing = (exitCode: number | null) => async () => {
      throw new SecurityCommandError(exitCode);
    };
    expect(await readClaudeOAuthToken(source({ runSecurity: failing(44) }))).toEqual({
      kind: "missing",
    });
    expect(await readClaudeOAuthToken(source({ runSecurity: failing(128) }))).toEqual({
      kind: "blocked",
    });
    expect(await readClaudeOAuthToken(source({ runSecurity: failing(null) }))).toEqual({
      kind: "blocked",
    });
    // The plaintext store still wins over a refused Keychain.
    expect(
      await readClaudeOAuthToken(
        source({ runSecurity: failing(128), readFile: async () => credentials("file-token") }),
      ),
    ).toMatchObject({ kind: "token" });
  });

  it("parses payloads without exposing token text on failure", () => {
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: {} }))).toBeNull();
    expect(parseClaudeCredentials(credentials(SECRET, null))).toEqual({
      accessToken: SECRET,
      expiresAt: null,
    });
  });
});

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "full_2026_11",
  label: "Full reset",
  type: "full",
  resets_total: 1,
  resets_left: 1,
  ends_at: "2026-12-10T22:00:00Z",
  clears: ["five_hour", "seven_day", "bogus"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  blocking: [],
  gives_back_weekly: false,
  unavailable_reason: null,
  ...overrides,
});

describe("normalizeClaudeLimitResets", () => {
  it("normalizes grants and drops malformed ones", () => {
    const value = normalizeClaudeLimitResets({
      cedar_ember: {
        eligible: true,
        grants: [
          grant(),
          grant({
            id: "fable",
            label: "Fable reset",
            type: "weekly",
            resets_total: 2,
            resets_left: 2,
            gives_back_weekly: true,
          }),
          grant({ id: "Bad Id!" }),
          grant({ id: "no-count", resets_left: -1 }),
          "junk",
        ],
        next_grant_id: "fable",
        cooldown_until: "not a date",
      },
    });
    expect(value).toEqual({
      grants: [
        {
          id: "full_2026_11",
          label: "Full reset",
          kind: "full",
          resetsLeft: 1,
          resetsTotal: 1,
          endsAt: "2026-12-10T22:00:00.000Z",
          usableNow: true,
          useRequiresLimit: false,
          givesBackWeekly: false,
          paused: false,
          clears: ["five_hour", "seven_day", "bogus"],
          blocking: [],
          unavailableReason: null,
        },
        expect.objectContaining({
          id: "fable",
          kind: "weekly",
          resetsLeft: 2,
          givesBackWeekly: true,
        }),
      ],
      nextGrantId: "fable",
      cooldownUntil: null,
    });
  });

  it("labels unnamed grants and ignores a next grant it does not list", () => {
    const value = normalizeClaudeLimitResets({
      cedar_ember: {
        eligible: true,
        grants: [grant({ label: "", type: "session" })],
        next_grant_id: "gone",
      },
    });
    expect(value?.grants[0]?.label).toBe("Session reset");
    expect(value?.nextGrantId).toBeNull();
  });

  it.each([
    [{}],
    [{ cedar_ember: null }],
    [{ cedar_ember: { eligible: false, grants: [grant()] } }],
    [{ cedar_ember: { eligible: true, ineligible_reason: "unavailable", grants: [grant()] } }],
  ])("returns null when the account has no limit resets (%j)", (response) => {
    expect(normalizeClaudeLimitResets(response)).toBeNull();
  });
});

describe("mapClaudeClaimResult", () => {
  it.each([
    [{ result: "reset", resets_left: 0 }, "reset"],
    // Claude Code treats this as a spent grant, not a replayed success.
    [{ result: "already_used" }, "noCredit"],
    [{ result: "not_limited" }, "nothingToReset"],
    [{ result: "ineligible", reason: "no_grant" }, "noCredit"],
    [{ result: "ineligible", reason: "expired" }, "noCredit"],
    [{ result: "ineligible", reason: "unknown_grant" }, "noCredit"],
    [{ result: "ineligible", reason: "tier" }, "unavailable"],
    [{ result: "cooldown", cooldown_until: "2026-11-15T10:00:00Z" }, "unavailable"],
    [{ result: "unavailable", reason: "paused" }, "unavailable"],
    [{ result: "unavailable", reason: "not_next_grant" }, "unavailable"],
    [{ result: "unavailable", reason: "expired" }, "noCredit"],
  ])("settles %j as %s", (response, outcome) => {
    const result = mapClaudeClaimResult(response);
    expect(result.outcome).toBe(outcome);
    if (outcome !== "reset" && outcome !== "nothingToReset") expect(result.message).toBeTruthy();
  });

  it.each([
    [{ result: "unavailable", reason: "reset_unconfirmed" }],
    [{ result: "unavailable", reason: "stamp_indeterminate" }],
    [{ result: "unavailable" }],
    [{ result: "something-new" }],
    [{ resets_left: 0 }],
    [null],
  ])("keeps %j pending", (response) => {
    expect(() => mapClaudeClaimResult(response)).toThrow(ClaudeLimitResetRequestError);
  });

  it("returns the cooldown time for the client to format", () => {
    expect(
      mapClaudeClaimResult({ result: "cooldown", cooldown_until: "2026-11-15T10:00:00Z" }),
    ).toEqual({
      outcome: "unavailable",
      message: "Limit resets are cooling down.",
      retryAt: "2026-11-15T10:00:00.000Z",
    });
    expect(mapClaudeClaimResult({ result: "cooldown" })).toEqual({
      outcome: "unavailable",
      message: "Limit resets are cooling down. Try again later.",
    });
    expect(mapClaudeClaimResult({ result: "unavailable", reason: "paused" }).message).toBe(
      "This limit reset is paused.",
    );
  });
});

describe("makeClaudeLimitResetClient", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const setup = (options: {
    tokens?: Array<ClaudeTokenRead>;
    responses: Array<Response | Error>;
    organization?: string | null;
  }) => {
    const tokens = [...(options.tokens ?? [])];
    const readToken = vi.fn(
      async (): Promise<ClaudeTokenRead> =>
        tokens.shift() ?? {
          kind: "token",
          token: { accessToken: SECRET, expiresAt: NOW + 3_600_000 },
        },
    );
    const refreshToken = vi.fn(async () => undefined);
    const responses = [...options.responses];
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      if (next instanceof Error) throw next;
      return next;
    });
    const client = makeClaudeLimitResetClient({
      readToken,
      readOrganizationUuid: async () =>
        options.organization === undefined ? "org-uuid" : options.organization,
      refreshToken,
      fetch,
      now: () => NOW,
      baseUrl: "https://api.test",
    });
    return { client, readToken, refreshToken, fetch };
  };

  it("reads status with the OAuth headers and caches the token", async () => {
    const body = {
      cedar_ember: { eligible: true, grants: [grant()], next_grant_id: "full_2026_11" },
    };
    const { client, fetch, readToken } = setup({ responses: [json(200, body), json(200, body)] });
    expect((await client.fetchStatus())?.grants).toHaveLength(1);
    await client.fetchStatus();
    expect(readToken).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`https://api.test${CLAUDE_LIMIT_RESET_STATUS_PATH}`);
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${SECRET}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "F5",
    });
  });

  it("reads status as null on any failure, without refreshing the token", async () => {
    const expired: ClaudeTokenRead = {
      kind: "token",
      token: { accessToken: SECRET, expiresAt: NOW + 30_000 },
    };
    const first = setup({ tokens: [expired], responses: [] });
    expect(await first.client.fetchStatus()).toBeNull();
    expect(first.fetch).not.toHaveBeenCalled();
    expect(first.refreshToken).not.toHaveBeenCalled();
    const second = setup({ responses: [json(401, {}), new Error("offline")] });
    expect(await second.client.fetchStatus()).toBeNull();
    expect(await second.client.fetchStatus()).toBeNull();
    // A 401 drops the cached token.
    expect(second.readToken).toHaveBeenCalledTimes(2);
  });

  it("stops reading an empty credential store in the background until invalidated", async () => {
    const body = { cedar_ember: { eligible: true, grants: [grant()] } };
    const { client, readToken, fetch } = setup({
      tokens: [{ kind: "missing" }],
      responses: [json(200, { result: "reset" }), json(200, body)],
    });
    expect(await client.fetchStatus()).toBeNull();
    // A denied Keychain prompt must not reappear on every refresh.
    expect(await client.fetchStatus()).toBeNull();
    expect(readToken).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    // An explicit claim still reads the store.
    expect(await client.claim("full", "req")).toEqual({ outcome: "reset" });
    expect(readToken).toHaveBeenCalledTimes(2);
    client.invalidate();
    expect((await client.fetchStatus())?.grants).toHaveLength(1);
  });

  it("claims a grant with the request id as the idempotency key", async () => {
    const { client, fetch } = setup({
      responses: [json(200, { result: "reset", resets_left: 0 })],
    });
    expect(await client.claim("full_2026_11", "1f0c-abc_DEF")).toEqual({ outcome: "reset" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.test/api/organizations/org-uuid/reset_rate_limits");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      program: "cedar_ember",
      grant_id: "full_2026_11",
      request_id: "1f0c-abc_DEF",
    });
  });

  it("refreshes through the CLI once after a 401 and retries", async () => {
    const { client, refreshToken, readToken, fetch } = setup({
      responses: [json(401, {}), json(200, { result: "reset" })],
    });
    expect(await client.claim("full", "req")).toEqual({ outcome: "reset" });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(readToken).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  const pendingError = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected the claim to stay pending");
      },
      (cause: unknown) => {
        expect(cause).toBeInstanceOf(ClaudeLimitResetRequestError);
        return (cause as Error).message;
      },
    );

  it("keeps the claim pending when it can't be sent, instead of settling it", async () => {
    const twice401 = setup({ responses: [json(401, {}), json(403, {})] });
    expect(await pendingError(twice401.client.claim("full", "req"))).toBe(
      CLAUDE_SIGN_IN_AGAIN_MESSAGE,
    );
    const missing = setup({ tokens: [{ kind: "missing" }], responses: [] });
    expect(await pendingError(missing.client.claim("full", "req"))).toBe(
      CLAUDE_SIGN_IN_AGAIN_MESSAGE,
    );
    expect(missing.fetch).not.toHaveBeenCalled();
    const blocked = setup({ tokens: [{ kind: "blocked" }], responses: [] });
    expect(await pendingError(blocked.client.claim("full", "req"))).toBe(
      CLAUDE_KEYCHAIN_BLOCKED_MESSAGE,
    );
    const noOrg = setup({ responses: [], organization: null });
    await pendingError(noOrg.client.claim("full", "req"));
    expect(noOrg.readToken).not.toHaveBeenCalled();
  });

  it("refreshes an expired token before claiming, and never twice", async () => {
    const { client, refreshToken, fetch } = setup({
      tokens: [{ kind: "token", token: { accessToken: "old", expiresAt: NOW - 1 } }],
      responses: [json(200, { result: "reset" })],
    });
    expect(await client.claim("full", "req")).toEqual({ outcome: "reset" });
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1].headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
    // A 401 after that refresh asks to sign in rather than refreshing again.
    const second = setup({
      tokens: [{ kind: "token", token: { accessToken: "old", expiresAt: NOW - 1 } }],
      responses: [json(401, {})],
    });
    expect(await pendingError(second.client.claim("full", "req"))).toBe(
      CLAUDE_SIGN_IN_AGAIN_MESSAGE,
    );
    expect(second.refreshToken).toHaveBeenCalledTimes(1);
    expect(second.fetch).toHaveBeenCalledTimes(1);
  });

  it("settles definite client errors, reading a structured answer when there is one", async () => {
    const { client } = setup({
      responses: [
        json(404, { error: "not found" }),
        json(409, { result: "already_used" }),
        json(422, { result: "unavailable", reason: "reset_unconfirmed" }),
      ],
    });
    expect(await client.claim("full", "req")).toEqual({
      outcome: "unavailable",
      message: "Claude rejected the reset request (HTTP 404).",
    });
    expect((await client.claim("full", "req")).outcome).toBe("noCredit");
    // An indeterminate answer stays pending even on a 4xx.
    await pendingError(client.claim("full", "req"));
  });

  it("passes the caller's abort signal to the request", async () => {
    const { client, fetch } = setup({ responses: [json(200, { result: "reset" })] });
    const controller = new AbortController();
    await client.claim("full", "req", controller.signal);
    const signal = fetch.mock.calls[0]![1].signal!;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("stops background reads after the Keychain refuses, until a claim or sign-in", async () => {
    const body = { cedar_ember: { eligible: true, grants: [grant()] } };
    const { client, readToken } = setup({
      tokens: [{ kind: "blocked" }],
      responses: [json(200, body), json(200, body)],
    });
    expect(await client.fetchStatus()).toBeNull();
    expect(await client.fetchStatus()).toBeNull();
    expect(readToken).toHaveBeenCalledTimes(1);
    client.invalidate();
    expect((await client.fetchStatus())?.grants).toHaveLength(1);
    expect(client.lastKnownStatus()?.grants).toHaveLength(1);
    client.invalidate();
    expect(client.lastKnownStatus()).toBeNull();
  });

  it("leaves 429s, server errors and network failures uncertain", async () => {
    const { client } = setup({
      responses: [
        json(429, {}),
        json(500, {}),
        new Error("offline"),
        new Response("<html>", { status: 200 }),
      ],
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      const error = await client.claim("full", "req").catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ClaudeLimitResetRequestError);
      expect(String((error as Error).message)).not.toContain(SECRET);
    }
  });

  it("refuses malformed grant or request ids without a request", async () => {
    const { client, fetch } = setup({ responses: [] });
    await pendingError(client.claim("Bad Id", "req"));
    await pendingError(client.claim("full", "bad id!"));
    expect(fetch).not.toHaveBeenCalled();
  });
});
