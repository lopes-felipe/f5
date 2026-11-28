import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { it as effectIt } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import {
  ANTIGRAVITY_QUOTA_SIGNAL_FALLBACK_MS,
  ANTIGRAVITY_USAGE_ARGS,
  type AntigravityLimitsInput,
  type AntigravityQuotaSignal,
  type AntigravityUsageRun,
  antigravityAccountLimitsIdentity,
  antigravityLimitsIdentity,
  makeAntigravityLimits,
  parseAntigravityUsageReport,
  runAntigravityUsageCommand,
  withQuotaSignal,
} from "./antigravityCliUsage.ts";
import { AccountUsageReadError } from "./accountUsageErrors.ts";

/**
 * The shape of `antigravity -p /usage --output-format json` from the bundled CLI 1.5.15, recorded
 * 2026-11-28 with descriptions shortened and fractions rounded. Untouched buckets report the Unix
 * epoch as their reset time.
 */
const report = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    response: "Gemini Models\tWeekly Limit Remaining\t39%\t2026-12-03T08:08:17Z\n",
    duration_seconds: 0,
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
    },
    command: {
      name: "usage",
      data: {
        description: "Within each group, models share a weekly limit and a 5-hour limit.",
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                id: "gemini-weekly",
                name: "Weekly Limit Remaining",
                window: "weekly",
                remaining_fraction: 0.39,
                reset_time: "2026-12-03T08:08:17Z",
              },
              {
                id: "gemini-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                remaining_fraction: 0.9,
                reset_time: "2026-11-28T17:41:07Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              {
                id: "3p-weekly",
                name: "Weekly Limit Remaining",
                window: "weekly",
                remaining_fraction: 1,
                reset_time: "1970-01-01T00:00:00Z",
              },
              {
                id: "3p-5h",
                name: "Five Hour Limit Remaining",
                window: "5h",
                remaining_fraction: 1,
                reset_time: "1970-01-01T00:00:00Z",
                disabled: true,
              },
            ],
          },
        ],
      },
    },
    ...overrides,
  });

const ran = (stdout: string, overrides: Partial<ProcessRunResult> = {}): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
  ...overrides,
});

describe("parseAntigravityUsageReport", () => {
  it("maps buckets to the pre-0.1.13 window ids and labels, skipping disabled ones", () => {
    const parsed = parseAntigravityUsageReport(report(), "", 0);
    expect(parsed).toEqual({
      kind: "windows",
      windows: [
        {
          id: "gemini-weekly",
          label: "Gemini · Weekly",
          usedPercent: expect.closeTo(61, 5),
          resetsAt: "2026-12-03T08:08:17.000Z",
          durationMinutes: 10_080,
        },
        {
          id: "gemini-5h",
          label: "Gemini · 5-hour",
          usedPercent: expect.closeTo(10, 5),
          resetsAt: "2026-11-28T17:41:07.000Z",
          durationMinutes: 300,
        },
        // An untouched bucket's epoch reset is no reset.
        {
          id: "3p-weekly",
          label: "Claude & GPT (shared) · Weekly",
          usedPercent: 0,
          resetsAt: null,
          durationMinutes: 10_080,
        },
      ],
    });
  });

  it("marks a report that spent a model turn, by turns or by tokens", () => {
    for (const overrides of [{ num_turns: 1 }, { usage: { total_tokens: 12 } }])
      expect(parseAntigravityUsageReport(report(overrides), "", 0)).toEqual({
        kind: "failed",
        errorCode: "unsupported",
        spentTurn: true,
      });
  });

  it("classifies signed-out, garbled, API-key and empty reports", () => {
    const signedOut = JSON.stringify({
      status: "ERROR",
      error: "authentication failed or timed out",
      num_turns: 0,
      usage: { total_tokens: 0 },
    });
    expect(
      parseAntigravityUsageReport(signedOut, "Authentication required. Please visit the URL", 1),
    ).toEqual({ kind: "failed", errorCode: "authentication-required" });
    expect(parseAntigravityUsageReport("not json", "", 1)).toEqual({
      kind: "failed",
      errorCode: "invalid-response",
    });
    expect(parseAntigravityUsageReport("", "", 2)).toEqual({
      kind: "failed",
      errorCode: "unsupported",
    });
    expect(
      parseAntigravityUsageReport(
        report({ command: { name: "usage", data: { groups: [] } } }),
        "",
        0,
      ),
    ).toEqual({ kind: "failed", errorCode: "invalid-response" });
    expect(
      parseAntigravityUsageReport(report({ command: { name: "help", data: {} } }), "", 0),
    ).toEqual({ kind: "failed", errorCode: "invalid-response" });
  });
});

describe.skipIf(process.platform === "win32")("runAntigravityUsageCommand", () => {
  const directories: Array<string> = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const fakeCli = async (body: string) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "f5-agy-usage-")));
    directories.push(root);
    const profile = path.join(root, "profile");
    await mkdir(path.join(profile, "antigravity-acp"), { recursive: true });
    await mkdir(path.join(profile, "config"), { recursive: true });
    const executable = path.join(root, "antigravity");
    await writeFile(executable, `#!/bin/sh\n${body}\n`);
    await chmod(executable, 0o755);
    return { root, profile, executable };
  };

  it("runs /usage in a temporary home linked to the profile, then removes it", async () => {
    const { root, profile, executable } = await fakeCli(
      [
        `printf '%s\\n' "$PWD" "$HOME" "$TMPDIR" "$@" > "${"$"}RECORD"`,
        `readlink "$HOME/.gemini/antigravity-cli" >> "$RECORD"`,
        `readlink "$HOME/.gemini/config" >> "$RECORD"`,
        `echo '{"ok":true}'`,
      ].join("\n"),
    );
    const record = path.join(root, "record");
    const result = await runAntigravityUsageCommand({
      executablePath: executable,
      profileDirectory: profile,
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", RECORD: record },
    });
    expect(result).toMatchObject({ code: 0, timedOut: false, stdout: '{"ok":true}\n' });
    const [cwd, home, temp, ...rest] = (await readFile(record, "utf8")).trim().split("\n");
    const runtime = path.dirname(home!);
    expect(path.dirname(runtime)).toBe(profile);
    expect(path.basename(runtime)).toMatch(/^\.runtime-/);
    expect(cwd).toBe(path.join(runtime, "cwd"));
    expect(temp).toBe(path.join(runtime, "tmp"));
    expect(rest).toEqual([
      ...ANTIGRAVITY_USAGE_ARGS,
      path.join(profile, "antigravity-acp"),
      path.join(profile, "config"),
    ]);
    // The runtime folder is gone and the profile keeps only what it had.
    expect((await readdir(profile)).sort()).toEqual(["antigravity-acp", "config"]);
    expect((await lstat(path.join(profile, "antigravity-acp"))).isDirectory()).toBe(true);
  });

  it("kills a run that outlives the timeout", async () => {
    const { profile, executable } = await fakeCli("sleep 5");
    const result = await runAntigravityUsageCommand({
      executablePath: executable,
      profileDirectory: profile,
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(await readdir(profile)).not.toContain(expect.stringMatching(/^\.runtime-/));
  });
});

/**
 * A fake driver run. The framework's clock is the TestClock, which starts at 0, so the reader's
 * `now` follows `clock` and tests advance both together.
 */
const harness = (
  options: {
    readonly version?: string | null;
    readonly result?: () => ProcessRunResult;
    /** Thrown before the body runs, as the driver's gates do. */
    readonly gate?: () => AccountUsageReadError | undefined;
  } = {},
) => {
  const state = { clock: 0, spawns: 0, account: "account-a" };
  const usageRun: AntigravityUsageRun = async (_signal, body) => {
    const blocked = options.gate?.();
    if (blocked) throw blocked;
    return body({
      version: options.version === undefined ? "1.5.15" : options.version,
      account: state.account,
      spawn: async () => {
        state.spawns += 1;
        return options.result?.() ?? ran(report());
      },
    });
  };
  const advance = (ms: number) =>
    Effect.sync(() => {
      state.clock += ms;
    }).pipe(Effect.andThen(TestClock.adjust(ms)));
  return { state, usageRun, advance };
};

const base = (
  run: ReturnType<typeof harness>,
  overrides: Partial<AntigravityLimitsInput> = {},
): AntigravityLimitsInput => ({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  displayName: "Antigravity",
  enabled: true,
  profileKey: "profile-a",
  billedPerToken: false,
  readLimitsWithCli: true,
  quotaSignal: () => undefined,
  currentAccount: async () => run.state.account,
  usageRun: run.usageRun,
  now: () => run.state.clock,
  ...overrides,
});

describe("makeAntigravityLimits", () => {
  effectIt.effect("never runs the CLI when reads are off or the instance uses an API key", () =>
    Effect.gen(function* () {
      const run = harness();
      const signal: AntigravityQuotaSignal = {
        observedAt: new Date(0).toISOString(),
        resetsAt: null,
        account: "account-a",
      };
      const permits = yield* Semaphore.make(1);
      const off = yield* makeAntigravityLimits(
        base(run, { readLimitsWithCli: false, quotaSignal: () => signal }),
      );
      const billed = yield* makeAntigravityLimits(
        base(run, { billedPerToken: true, quotaSignal: () => signal }),
      );
      yield* off.refresh("force", permits);
      yield* billed.refresh("force", permits);
      expect(run.state.spawns).toBe(0);
      expect((yield* off.getSnapshot).sections).toMatchObject([
        {
          outcome: "unsupported",
          errorCode: "unsupported",
          readsDisabled: true,
          snapshot: null,
          quotaExhausted: { observedAt: signal.observedAt, resetsAt: null },
        },
      ]);
      // A key's rate limit is not a subscription quota stop.
      const [billedSection] = (yield* billed.getSnapshot).sections;
      expect(billedSection).toMatchObject({
        outcome: "available",
        snapshot: { data: { windows: [], plan: "Billed per token" } },
      });
      expect(billedSection).not.toHaveProperty("quotaExhausted");
    }).pipe(Effect.scoped),
  );

  effectIt.effect("gates old, unreadable and refused versions before spawning", () =>
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(1);
      for (const [version, refusal, expected] of [
        ["1.5.14", undefined, { outcome: "unsupported", unsupportedReason: "cli-too-old" }],
        [null, undefined, { outcome: "unavailable", errorCode: "process-unavailable" }],
        [
          "1.5.15",
          { version: "1.5.15", reason: "cli-unrecognized" as const },
          { outcome: "unsupported", unsupportedReason: "cli-unrecognized" },
        ],
      ] as const) {
        const run = harness({ version });
        const capability = yield* makeAntigravityLimits(
          base(run, { refusal: async () => refusal }),
        );
        const { snapshot } = yield* capability.refreshAccount!(permits, "force");
        expect(snapshot.sections).toMatchObject([{ ...expected, accountFingerprint: "account-a" }]);
        expect(run.state.spawns).toBe(0);
      }
    }).pipe(Effect.scoped),
  );

  effectIt.effect("spaces real runs a minute apart without calling throttled refreshes fresh", () =>
    Effect.gen(function* () {
      const run = harness();
      const verified: Array<string> = [];
      const capability = yield* makeAntigravityLimits(
        base(run, {
          verify: async (version) => {
            verified.push(version);
          },
        }),
      );
      const permits = yield* Semaphore.make(1);
      const first = yield* capability.refreshAccount!(permits, "force");
      expect(first.fresh).toBe(true);
      expect(verified).toEqual(["1.5.15"]);
      expect(first.snapshot.sections[0]).toMatchObject({
        outcome: "available",
        accountFingerprint: "account-a",
        snapshot: {
          data: {
            accountFingerprint: "account-a",
            windows: expect.arrayContaining([expect.objectContaining({ id: "gemini-weekly" })]),
          },
        },
      });
      // Past the framework's 5-second force throttle, inside the 60-second floor.
      yield* run.advance(10_000);
      const throttled = yield* capability.refreshAccount!(permits, "force");
      expect(run.state.spawns).toBe(1);
      expect(throttled.fresh).toBe(false);
      expect(throttled.nextAllowedAt).toBe(new Date(60_000).toISOString());
      yield* run.advance(50_000);
      const second = yield* capability.refreshAccount!(permits, "force");
      expect(run.state.spawns).toBe(2);
      expect(second.fresh).toBe(true);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("lets a refresh run at once after a gate failure or an interrupted run", () =>
    Effect.gen(function* () {
      let gate: AccountUsageReadError | undefined = new AccountUsageReadError(
        "authentication-required",
      );
      let aborted = false;
      const run = harness({
        gate: () => gate,
        result: () => (aborted ? ran("", { aborted: true, code: null }) : ran(report())),
      });
      const capability = yield* makeAntigravityLimits(base(run));
      const permits = yield* Semaphore.make(1);
      const signedOut = yield* capability.refreshAccount!(permits, "force");
      expect(signedOut.snapshot.sections).toMatchObject([
        { outcome: "unavailable", errorCode: "authentication-required" },
      ]);
      gate = undefined;
      aborted = true;
      yield* run.advance(6_000);
      yield* capability.refreshAccount!(permits, "force");
      expect(run.state.spawns).toBe(1);
      aborted = false;
      yield* run.advance(6_000);
      const recovered = yield* capability.refreshAccount!(permits, "force");
      expect(run.state.spawns).toBe(2);
      expect(recovered.fresh).toBe(true);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("stops asking a version that spent a turn, even when saving that fails", () =>
    Effect.gen(function* () {
      const run = harness({ result: () => ran(report({ usage: { thinking_tokens: 3 } })) });
      const refused: Array<[string, string]> = [];
      const capability = yield* makeAntigravityLimits(
        base(run, {
          refuse: async (version, reason) => {
            refused.push([version, reason]);
            throw new Error("read-only state file");
          },
        }),
      );
      const permits = yield* Semaphore.make(1);
      const { snapshot } = yield* capability.refreshAccount!(permits, "force");
      expect(refused).toEqual([["1.5.15", "cli-spends-turn"]]);
      expect(snapshot.sections).toMatchObject([
        { outcome: "unsupported", unsupportedReason: "cli-spends-turn" },
      ]);
      yield* run.advance(10 * 60_000);
      yield* capability.refreshAccount!(permits, "force");
      expect(run.state.spawns).toBe(1);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("refuses an unverified version whose first answer is unrecognised", () =>
    Effect.gen(function* () {
      const permits = yield* Semaphore.make(1);
      for (const [result, knownGood, expected] of [
        [
          ran("", { code: null, timedOut: true }),
          undefined,
          { unsupportedReason: "cli-unrecognized" },
        ],
        [ran("plain text answer"), undefined, { unsupportedReason: "cli-unrecognized" }],
        [ran("", { code: null, timedOut: true }), "1.5.15", { errorCode: "timeout" }],
        [
          ran("", {
            code: null,
            timedOut: true,
            stderr: "Authentication required. Please visit the URL to log in:",
          }),
          undefined,
          { errorCode: "authentication-required" },
        ],
      ] as const) {
        const run = harness({ result: () => result });
        const refused: Array<string> = [];
        const capability = yield* makeAntigravityLimits(
          base(run, {
            verifiedVersion: async () => knownGood,
            refuse: async (version) => {
              refused.push(version);
            },
          }),
        );
        const { snapshot } = yield* capability.refreshAccount!(permits, "force");
        expect(snapshot.sections).toMatchObject([expected]);
        expect(refused).toEqual("unsupportedReason" in expected ? ["1.5.15"] : []);
      }
    }).pipe(Effect.scoped),
  );

  effectIt.effect("hides another account's limits and quota stop after a sign-in switch", () =>
    Effect.gen(function* () {
      const run = harness({
        gate: () => (run.state.account === "account-b" ? failing : undefined),
      });
      const failing = new AccountUsageReadError("timeout");
      let signal: AntigravityQuotaSignal | undefined;
      const capability = yield* makeAntigravityLimits(base(run, { quotaSignal: () => signal }));
      const permits = yield* Semaphore.make(1);
      const first = yield* capability.refreshAccount!(permits, "force");
      expect(capability.identityForSnapshot!(first.snapshot)).toBe(
        antigravityAccountLimitsIdentity("account-a"),
      );
      signal = { observedAt: new Date(1).toISOString(), resetsAt: null, account: "account-a" };
      run.state.account = "account-b";
      const switched = yield* capability.getSnapshot;
      expect(switched.sections).toEqual([
        expect.objectContaining({ snapshot: null, accountFingerprint: "account-b" }),
      ]);
      expect(switched.sections[0]).not.toHaveProperty("quotaExhausted");
      expect(capability.identityForSnapshot!(switched)).toBe(
        antigravityAccountLimitsIdentity("account-b"),
      );
      // B's first read fails; A's reading is never shown as B's last known limits.
      yield* run.advance(61_000);
      const failed = yield* capability.refreshAccount!(permits, "force");
      expect(failed.snapshot.sections).toEqual([
        expect.objectContaining({ errorCode: "timeout", snapshot: null }),
      ]);
    }).pipe(Effect.scoped),
  );

  it("keeps instances and accounts apart in history", () => {
    expect(antigravityLimitsIdentity("profile-a")).not.toBe(antigravityLimitsIdentity("profile-b"));
    expect(antigravityAccountLimitsIdentity("a")).not.toBe(antigravityAccountLimitsIdentity("b"));
  });
});

describe("withQuotaSignal", () => {
  const observedAt = "2026-11-28T12:00:00.000Z";
  const account = (section: Record<string, unknown> = {}) => ({
    key: "antigravity:test",
    provider: "antigravity" as const,
    providerInstanceId: ProviderInstanceId.make("antigravity-test"),
    displayName: "Antigravity",
    enabled: true,
    refreshState: "idle" as const,
    sections: [
      {
        kind: "provider-limits" as const,
        outcome: "unsupported" as const,
        lastAttemptAt: null,
        snapshot: null,
        errorCode: "unsupported" as const,
        readsDisabled: true,
        ...section,
      },
    ],
  });
  const at = (iso: string) => Date.parse(iso);

  it("shows the stop until its reset, without adding a window", () => {
    const signal: AntigravityQuotaSignal = { observedAt, resetsAt: "2026-11-28T13:00:00.000Z" };
    const shown = withQuotaSignal(account(), signal, at("2026-11-28T12:30:00Z"));
    expect(shown.sections[0]).toMatchObject({ quotaExhausted: signal, snapshot: null });
    expect(
      withQuotaSignal(account(), signal, at("2026-11-28T13:00:00Z")).sections[0],
    ).not.toHaveProperty("quotaExhausted");
  });

  it("expires a stop with no reset time after five hours", () => {
    const signal: AntigravityQuotaSignal = { observedAt, resetsAt: null };
    const later = at(observedAt) + ANTIGRAVITY_QUOTA_SIGNAL_FALLBACK_MS;
    expect(withQuotaSignal(account(), signal, later - 1).sections[0]).toHaveProperty(
      "quotaExhausted",
    );
    expect(withQuotaSignal(account(), signal, later).sections[0]).not.toHaveProperty(
      "quotaExhausted",
    );
  });

  it("gives way to a limits reading taken after the stop", () => {
    const signal: AntigravityQuotaSignal = { observedAt, resetsAt: null };
    const reading = (fetchedAt: string) =>
      account({
        outcome: "available",
        errorCode: null,
        readsDisabled: undefined,
        snapshot: {
          fetchedAt,
          data: {
            windows: [
              { id: "gemini-5h", label: "Gemini · 5-hour", usedPercent: 100, resetsAt: null },
            ],
          },
        },
      });
    const now = at("2026-11-28T12:10:00Z");
    expect(
      withQuotaSignal(reading("2026-11-28T12:05:00.000Z"), signal, now).sections[0],
    ).not.toHaveProperty("quotaExhausted");
    expect(
      withQuotaSignal(reading("2026-11-28T11:55:00.000Z"), signal, now).sections[0],
    ).toHaveProperty("quotaExhausted");
    // A later failed refresh keeps the newer reading; the cleared stop stays cleared.
    const failedAfter = account({
      ...reading("2026-11-28T12:05:00.000Z").sections[0],
      outcome: "unavailable",
      errorCode: "timeout",
    });
    expect(withQuotaSignal(failedAfter, signal, now).sections[0]).not.toHaveProperty(
      "quotaExhausted",
    );
  });

  it("never shows a stop observed under another account", () => {
    const signal: AntigravityQuotaSignal = { observedAt, resetsAt: null, account: "account-a" };
    const now = at("2026-11-28T12:10:00Z");
    expect(withQuotaSignal(account(), signal, now, "account-a").sections[0]).toHaveProperty(
      "quotaExhausted",
    );
    expect(withQuotaSignal(account(), signal, now, "account-b").sections[0]).not.toHaveProperty(
      "quotaExhausted",
    );
  });
});
