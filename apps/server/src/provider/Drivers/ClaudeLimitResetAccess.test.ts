import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import { Effect, Exit, Schema } from "effect";

import {
  ClaudeLimitResetRequestError,
  type ClaudeLimitResetClient,
} from "../../usage/claudeLimitResets.ts";
import {
  makeClaudeConsumeResetCredit,
  makeClaudeLimitResetAccess,
} from "./ClaudeLimitResetAccess.ts";

const settings = Schema.decodeSync(ClaudeSettings)({});
const credentials = JSON.stringify({
  claudeAiOauth: { accessToken: "file-token", expiresAt: Date.now() + 3_600_000 },
});

const tempConfigDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(NodeOS.tmpdir(), "claude-limit-resets-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
);

it.layer(NodeServices.layer)("Claude limit-reset access", (it) => {
  it.effect("reads the token and organization from the instance's config dir", () =>
    Effect.gen(function* () {
      const dir = yield* tempConfigDir;
      yield* Effect.promise(async () => {
        await writeFile(NodePath.join(dir, ".credentials.json"), credentials);
        await writeFile(
          NodePath.join(dir, ".claude.json"),
          JSON.stringify({ oauthAccount: { organizationUuid: "org-from-state" } }),
        );
      });
      const requests: Array<[string, RequestInit]> = [];
      const securityCalls: Array<ReadonlyArray<string>> = [];
      const client = yield* makeClaudeLimitResetAccess(
        settings,
        { CLAUDE_CONFIG_DIR: dir, HOME: dir, USER: "tester" },
        {
          cwd: dir,
          refreshToken: async () => undefined,
          platform: "darwin",
          runSecurity: async (args) => {
            securityCalls.push(args);
            throw new Error("item not found");
          },
          fetch: async (url, init) => {
            requests.push([url, init]);
            return new Response(JSON.stringify({ result: "reset" }), { status: 200 });
          },
        },
      );
      const result = yield* Effect.promise(() => client.claim("full", "req-1"));
      assert.deepStrictEqual(result, { outcome: "reset" });
      // The Keychain is asked for this config dir's entry first, then the file is used.
      assert.equal(securityCalls[0]?.at(-1)?.startsWith("Claude Code-credentials-"), true);
      assert.equal(
        requests[0]?.[0].endsWith("/api/organizations/org-from-state/reset_rate_limits"),
        true,
      );
      assert.deepInclude(requests[0]?.[1].headers as Record<string, string>, {
        Authorization: "Bearer file-token",
      });
    }),
  );

  it.effect("stays off for a custom API endpoint", () =>
    Effect.gen(function* () {
      const dir = yield* tempConfigDir;
      yield* Effect.promise(async () => {
        await writeFile(NodePath.join(dir, ".credentials.json"), credentials);
        await writeFile(
          NodePath.join(dir, "settings.json"),
          JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example" } }),
        );
      });
      let fetched = false;
      const client = yield* makeClaudeLimitResetAccess(
        settings,
        { CLAUDE_CONFIG_DIR: dir, HOME: dir },
        {
          cwd: dir,
          refreshToken: async () => undefined,
          platform: "linux",
          fetch: async () => {
            fetched = true;
            return new Response("{}", { status: 200 });
          },
        },
      );
      assert.equal(yield* Effect.promise(() => client.fetchStatus()), null);
      assert.equal(fetched, false);
    }),
  );
});

it.effect("consumeResetCredit requires a grant and keeps failed claims pending", () =>
  Effect.gen(function* () {
    const calls: Array<[string, string]> = [];
    const client: Pick<ClaudeLimitResetClient, "claim"> = {
      claim: async (grantId, requestId) => {
        calls.push([grantId, requestId]);
        if (grantId === "flaky") throw new ClaudeLimitResetRequestError("Claude timed out.", null);
        if (grantId === "broken") throw new Error("boom");
        return { outcome: "reset" };
      },
    };
    const consume = makeClaudeConsumeResetCredit(client, "claudeAgent", "claude-1");
    assert.deepStrictEqual(yield* consume("key-1", "full"), { outcome: "reset" });
    assert.deepStrictEqual(calls, [["full", "key-1"]]);

    // No grant: never guess one, since a replay could then target a different grant.
    const missing = yield* Effect.exit(consume("key-2"));
    assert.equal(Exit.isFailure(missing), true);
    assert.equal(calls.length, 1);

    const flaky = yield* Effect.flip(consume("key-3", "flaky"));
    assert.equal(flaky._tag, "ProviderDriverError");
    assert.equal(flaky.detail, "Claude timed out.");
    assert.equal(flaky.instanceId, "claude-1");
    const broken = yield* Effect.flip(consume("key-4", "broken"));
    assert.equal(broken.detail, "Could not claim a Claude limit reset.");
  }),
);
