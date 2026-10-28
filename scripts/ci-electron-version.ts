import { appendFileSync, readFileSync } from "node:fs";
import { electronVersion } from "./lib/ci-electron-version.ts";

const version = electronVersion(JSON.parse(readFileSync("apps/desktop/package.json", "utf8")));
if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
appendFileSync(process.env.GITHUB_OUTPUT, "version=" + version + "\n");
