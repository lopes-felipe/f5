// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { gh } from "./release/release-github.ts";
import { parseStableIntent } from "./release/release-candidate.ts";
const { values } = parseArgs({
  options: { stable: { type: "string" }, recover: { type: "string" } },
});
const intent = parseStableIntent({
  version: values.stable,
  requestId: randomUUID(),
  ...(values.recover ? { supersedes: values.recover } : {}),
});
gh([
  "workflow",
  "run",
  "release-prepare.yml",
  "--ref",
  "main",
  "-f",
  "version=" + intent.version,
  "-f",
  "request_id=" + intent.requestId,
  ...(intent.supersedes ? ["-f", "supersedes=" + intent.supersedes] : []),
]);
console.log("Stable preparation dispatched:", intent.requestId);
