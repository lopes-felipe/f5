const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

// Only explicitly supplied text and fixture screenshots may leave the harness.
// Never copy a temporary state directory, database, provider home or auth file.
function sanitize(text, { secrets = [], paths = [] } = {}) {
  let result = String(text);
  const environmentSecrets = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /TOKEN|SECRET|PASSWORD|API_KEY|COOKIE|AUTHORIZATION/i.test(key) &&
        value &&
        value.length >= 6,
    )
    .map(([, value]) => value);
  for (const value of [...secrets, ...environmentSecrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    result = result.split(value).join("[REDACTED]");
  result = result
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(
      /([?&](?:token|key|auth|code|cookie|password|secret)[^=\s]*=)[^&\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:"|')?(?:[\w-]*(?:token|secret|password|cookie|api[_-]?key|authorization)[\w-]*)(?:"|')?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    );
  for (const value of paths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(value).join("[TEMP]");
    result = result.split(value.replaceAll("\\", "\\\\")).join("[TEMP]");
  }
  return result.slice(-65_536);
}
function writeDiagnostics(
  directory,
  name,
  { logs = "", failure = "", screenshot, secrets = [], paths = [] },
) {
  if (!directory) return;
  const target = join(directory, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "process.log"), sanitize(logs, { secrets, paths }));
  writeFileSync(
    join(target, "result.json"),
    JSON.stringify({ passed: !failure, failure: sanitize(failure, { secrets, paths }) }, null, 2),
  );
  if (screenshot) writeFileSync(join(target, "fixture.png"), screenshot);
}
module.exports = { sanitize, writeDiagnostics };
