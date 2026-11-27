/**
 * Replays recorded shell commands through the read-only classifier and prints, per group, how
 * many it refuses and why. Run it before and after a classifier change to see what the change
 * does to commands read-only stages really ran:
 *
 *   bun scripts/replay-read-only-commands.ts <commands.json> [--top <n>] [--truncated-at <n>]
 *
 * The input is a JSON array of `{ "provider": string, "detail": string }` rows (or plain
 * strings), `detail` being the command as the provider reported it; Codex's
 * `/bin/zsh -lc '<script>'` form is unwrapped as the Codex adapter does. Some sources cut a long
 * command at a fixed length: pass that length as `--truncated-at` and those rows are counted
 * apart, since a cut command usually no longer parses.
 *
 * Reads the file and prints; it runs none of the commands. Recorded commands can name private
 * paths and repositories, so keep the input out of the repository.
 */
import { readFileSync } from "node:fs";
import {
  classifyReadOnlyShellCommand,
  unwrapShellInvocation,
} from "../src/provider/readOnlyWorkflowShell";

interface GroupTally {
  accepted: number;
  refused: number;
  truncated: number;
  readonly reasons: Map<string, { count: number; example: string }>;
}

/** Folds the variable or program a reason names, so one cause is one line. */
function reasonKey(reason: string): string {
  return (
    reason
      .replace(/\$\{?\w+\}?/g, "$VAR")
      .replace(/^(setting|looping over) \w+ /, "$1 VAR ")
      .replace(/^\w+ (is built from|is already set|must be set to)/, "VAR $1")
      // The advice names the variable again without a `$`: "set F before the chain", "set F=value".
      .replace(/\bset \w+(?= before the chain|=value)/g, "set VAR")
      .replace(/\(.*\)/, "(…)")
  );
}

function numberFlag(args: ReadonlyArray<string>, name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} needs a positive integer`);
  return value;
}

function main(argv: ReadonlyArray<string>): void {
  const file = argv.find(
    (arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"),
  );
  if (!file) throw new Error("usage: replay-read-only-commands.ts <commands.json> [--top <n>]");
  const top = numberFlag(argv, "--top", 20);
  const truncatedAt = numberFlag(argv, "--truncated-at", Number.MAX_SAFE_INTEGER);

  const rows: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`${file} must hold a JSON array`);
  const groups = new Map<string, GroupTally>();
  for (const row of rows) {
    const detail = typeof row === "string" ? row : (row as { detail?: unknown } | null)?.detail;
    if (typeof detail !== "string" || detail.trim().length === 0) continue;
    const provider = typeof row === "string" ? undefined : (row as { provider?: unknown }).provider;
    const name = typeof provider === "string" ? provider : "commands";
    const tally = groups.get(name) ?? { accepted: 0, refused: 0, truncated: 0, reasons: new Map() };
    groups.set(name, tally);
    if (detail.length >= truncatedAt) {
      tally.truncated += 1;
      continue;
    }
    const verdict = classifyReadOnlyShellCommand(unwrapShellInvocation(detail));
    if (verdict.readOnly) {
      tally.accepted += 1;
      continue;
    }
    tally.refused += 1;
    const key = reasonKey(verdict.reason);
    const entry = tally.reasons.get(key) ?? { count: 0, example: detail };
    entry.count += 1;
    tally.reasons.set(key, entry);
  }

  for (const [name, tally] of groups) {
    const total = tally.accepted + tally.refused;
    const rate = total === 0 ? "0.0" : ((100 * tally.refused) / total).toFixed(1);
    console.log(
      `\n${name}: ${tally.refused} of ${total} refused (${rate}%)` +
        (tally.truncated > 0 ? `, ${tally.truncated} truncated rows skipped` : ""),
    );
    const reasons = [...tally.reasons].toSorted((left, right) => right[1].count - left[1].count);
    for (const [reason, { count, example }] of reasons.slice(0, top)) {
      console.log(`${String(count).padStart(6)}  ${reason}`);
      console.log(`        e.g. ${example.replace(/\s+/g, " ").slice(0, 140)}`);
    }
    if (reasons.length > top) console.log(`        … and ${reasons.length - top} more reasons`);
  }
}

main(process.argv.slice(2));
