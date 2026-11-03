import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { userInfo } from "node:os";

export const RULE_PATH = "/etc/sudoers.d/f5-keep-awake";
export type WriteResult = "ok" | "denied" | "unknown";
export type RuleResult = "ok" | "cancelled" | "failed";
export function run(
  file: string,
  args: string[],
  timeout = 10_000,
): Promise<{ ok: boolean; output: string; error: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          timeout,
          maxBuffer: 64 * 1024,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
        },
        (error, stdout, stderr) => resolve({ ok: !error, output: stdout, error: stderr }),
      );
    } catch (error) {
      resolve({ ok: false, output: "", error: String(error) });
    }
  });
}
export function parseSleepDisabled(output: string): 0 | 1 | null {
  const lines = output.split(/\r?\n/);
  const section = lines.findIndex((line) => line.trim() === "System-wide power settings:");
  if (section < 0) return null;
  const entries: string[] = [];
  for (const line of lines.slice(section + 1)) {
    if (/^\S.*:\s*$/.test(line)) break;
    if (/^\s*SleepDisabled\b/.test(line)) entries.push(line.trim());
  }
  if (!entries.length) return 0;
  if (entries.length !== 1) return null;
  const match = /^SleepDisabled\s+([01])$/.exec(entries[0]!);
  return match ? (Number(match[1]) as 0 | 1) : null;
}
export function parseBatteryPercent(output: string): number | null {
  const match = /(?:^|\s)(\d{1,3})%;/m.exec(output);
  return match && Number(match[1]) <= 100 ? Number(match[1]) : null;
}
export function parseLid(output: string): boolean | null {
  const matches = [...output.matchAll(/"AppleClamshellState"\s*=\s*(Yes|No)\b/g)];
  return matches.length === 1 ? matches[0]![1] === "Yes" : null;
}
export function sudoersText(username: string) {
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(username)) throw new Error("Invalid account name");
  return (
    "Cmnd_Alias F5_KEEP_AWAKE = /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0\n" +
    username +
    " ALL=(root) NOPASSWD: F5_KEEP_AWAKE\n"
  );
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function installScript(username: string) {
  return (
    "set -eu\nf=$(/usr/bin/mktemp)\ntrap '/bin/rm -f \"$f\"' EXIT\n/usr/bin/printf '%s' " +
    quote(sudoersText(username)) +
    ' > "$f"\n/usr/sbin/visudo -cf "$f"\n/usr/bin/install -m 0440 -o root -g wheel "$f" ' +
    RULE_PATH
  );
}
async function authorize(script: string): Promise<RuleResult> {
  const result = await run(
    "/usr/bin/osascript",
    [
      "-e",
      "on run argv",
      "-e",
      "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges",
      "-e",
      "end run",
      script,
      "F5 needs permission to manage closed-lid sleep.",
    ],
    120_000,
  );
  return result.ok ? "ok" : result.error.includes("(-128)") ? "cancelled" : "failed";
}
export function createMacPower() {
  const readSleepDisabled = async () => {
    const result = await run("/usr/bin/pmset", ["-g"]);
    return result.ok ? parseSleepDisabled(result.output) : null;
  };
  return {
    readSleepDisabled,
    async setSleepDisabled(value: 0 | 1): Promise<WriteResult> {
      const result = await run("/usr/bin/sudo", [
        "-n",
        "/usr/bin/pmset",
        "-a",
        "disablesleep",
        String(value),
      ]);
      const readback = await readSleepDisabled();
      if (result.ok && readback === value) return "ok";
      if (!result.ok && result.error.includes("a password is required")) return "denied";
      return "unknown";
    },
    async sudoRuleAvailable() {
      return (await run("/usr/bin/sudo", ["-n", "-l", "/usr/bin/pmset", "-a", "disablesleep", "1"]))
        .ok;
    },
    async readBatteryPercent() {
      const result = await run("/usr/bin/pmset", ["-g", "batt"]);
      return result.ok ? parseBatteryPercent(result.output) : null;
    },
    async lidHardware(): Promise<"present" | "absent" | "unknown"> {
      const result = await run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"]);
      return !result.ok
        ? "unknown"
        : result.output.includes('"AppleClamshellState"')
          ? "present"
          : "absent";
    },
    async readLidClosed() {
      const result = await run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "1"]);
      return result.ok ? parseLid(result.output) : null;
    },
    async displaySleepNow() {
      await run("/usr/bin/pmset", ["displaysleepnow"]);
    },
    installRule: () => authorize(installScript(userInfo().username)),
    removeRule: () => authorize("/bin/rm -f " + RULE_PATH),
    async ruleInstalledByF5() {
      try {
        await access(RULE_PATH);
        return true;
      } catch {
        return false;
      }
    },
  };
}
export type MacPower = ReturnType<typeof createMacPower>;
