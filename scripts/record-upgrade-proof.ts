// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashFile } from "./release/release-github.ts";
import { windowsUpgradeAssets } from "./published-windows-upgrade.ts";
const env = process.env;
const record = JSON.parse(readFileSync("rehearsal-logs/published-upgrade.json", "utf8"));
const installer = windowsUpgradeAssets(env.VERSION!, env.CHANNEL as "latest" | "beta").find((n) =>
  n.endsWith(".exe"),
)!;
mkdirSync("upgrade-receipt", { recursive: true });
writeFileSync(
  "upgrade-receipt/upgrade.json",
  JSON.stringify(
    {
      ...record,
      sourceSha: env.SOURCE_SHA,
      installerSha256: await hashFile(join("published-upgrade/target", installer)),
    },
    null,
    2,
  ) + "\n",
);
