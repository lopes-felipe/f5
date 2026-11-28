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
  antigravityLimitsIdentity,
  makeAntigravityLimits,
  parseAntigravityUsageReport,
  runAntigravityUsageCommand,
  withQuotaSignal,
} from "./antigravityCliUsage.ts";

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

const base = (overrides: Partial<AntigravityLimitsInput> = {}): AntigravityLimitsInput => ({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  displayName: "Antigravity",
  enabled: true,
  profileKey: "profile-a",
  billedPerToken: false,
  readLimitsWithCli: true,
  quotaSignal: () => undefined,
  runtimeVersion: async () => "1.5.15",
  refusedVersion: async () => undefined,
  ...overrides,
});

describe("makeAntigravityLimits", () => {
  effectIt.effect("never runs the CLI when reads are off or the instance uses an API key", () =>
    Effect.gen(function* () {
      let runs = 0;
      const runUsage = async () => {
        runs += 1;
        return ran(report());
      };
      const permits = yield* Semaphore.make(1);
      const off = yield* makeAntigravityLimits(base({ readLimitsWithCli: false, runUsage }));
      const billed = yield* makeAntigravityLimits(base({ billedPerToken: true, runUsage }));
      yield* off.refresh("force", permits);
      yield* billed.refresh("force", permits);
      expect(runs).toBe(0);
      expect((yield* off.getSnapshot).sections).toMatchObject([
        { outcome: "unsupported", errorCode: "unsupported", readsDisabled: true, snapshot: null },
      ]);
      expect((yield* billed.getSnapshot).sections).toMatchObject([
        { outcome: "available", snapshot: { data: { windows: [], plan: "Billed per token" } } },
      ]);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("refuses old, unknown and refused runtime versions before spawning", () =>
    Effect.gen(function* () {
      let runs = 0;
      const runUsage = async () => {
        runs += 1;
        return ran(report());
      };
      const permits = yield* Semaphore.make(1);
      for (const [version, refused, reason] of [
        ["1.5.14", undefined, "cli-too-old"],
        [null, undefined, "cli-too-old"],
        ["1.5.15", "1.5.15", "cli-spends-turn"],
      ] as const) {
        const capability = yield* makeAntigravityLimits(
          base({
            runUsage,
            runtimeVersion: async () => version,
            refusedVersion: async () => refused,
          }),
        );
        const { snapshot } = yield* capability.refreshAccount!(permits, "force");
        expect(snapshot.sections).toMatchObject([
          { outcome: "unsupported", unsupportedReason: reason },
        ]);
      }
      expect(runs).toBe(0);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("publishes the windows and replays them within the 60-second floor", () =>
    Effect.gen(function* () {
      let now = Date.parse("2026-11-28T12:00:00Z");
      let runs = 0;
      const capability = yield* makeAntigravityLimits(
        base({
          now: () => now,
          runUsage: async () => {
            runs += 1;
            return ran(report());
          },
        }),
      );
      const permits = yield* Semaphore.make(1);
      const first = yield* capability.refreshAccount!(permits, "force");
      expect(first.fresh).toBe(true);
      expect(first.snapshot.sections[0]).toMatchObject({
        outcome: "available",
        snapshot: {
          data: {
            windows: expect.arrayContaining([expect.objectContaining({ id: "gemini-weekly" })]),
          },
        },
      });
      // Past the framework's force throttle, inside the reader's floor.
      yield* TestClock.adjust("10 seconds");
      now += 10_000;
      yield* capability.refreshAccount!(permits, "force");
      expect(runs).toBe(1);
      yield* TestClock.adjust("60 seconds");
      now += 60_000;
      yield* capability.refreshAccount!(permits, "force");
      expect(runs).toBe(2);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("stops asking a runtime version whose /usage spent a turn", () =>
    Effect.gen(function* () {
      const refused: Array<string> = [];
      const capability = yield* makeAntigravityLimits(
        base({
          runUsage: async () => ran(report({ num_turns: 1 })),
          refuseVersion: async (version) => {
            refused.push(version);
          },
        }),
      );
      const { snapshot } = yield* capability.refreshAccount!(yield* Semaphore.make(1), "force");
      expect(refused).toEqual(["1.5.15"]);
      expect(snapshot.sections).toMatchObject([
        { outcome: "unsupported", unsupportedReason: "cli-spends-turn" },
      ]);
    }).pipe(Effect.scoped),
  );

  effectIt.effect(
    "reports a timed-out sign-in prompt as signed out and other timeouts as such",
    () =>
      Effect.gen(function* () {
        for (const [stderr, errorCode] of [
          ["Authentication required. Please visit the URL to log in:", "authentication-required"],
          ["", "timeout"],
        ] as const) {
          const capability = yield* makeAntigravityLimits(
            base({ runUsage: async () => ran("", { code: null, timedOut: true, stderr }) }),
          );
          const { snapshot } = yield* capability.refreshAccount!(yield* Semaphore.make(1), "force");
          expect(snapshot.sections).toMatchObject([{ outcome: "unavailable", errorCode }]);
        }
      }).pipe(Effect.scoped),
  );

  it("keeps each instance's history apart", () => {
    expect(antigravityLimitsIdentity("profile-a")).not.toBe(antigravityLimitsIdentity("profile-b"));
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
  });
});
