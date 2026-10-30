// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { gh } from "./release/release-github.ts";
import { parseReleaseIntent } from "./release/release-intent.ts";
const { values } = parseArgs({
  options: {
    stable: { type: "string" },
    recover: { type: "string" },
    withdraw: { type: "string" },
    reason: { type: "string" },
  },
});
if (values.withdraw && (values.stable || values.recover))
  throw new Error("Withdrawal cannot prepare or recover another release");
const intent = parseReleaseIntent(
  values.withdraw
    ? {
        action: "withdraw",
        requestId: randomUUID(),
        withdraws: values.withdraw.split(",").map((id) => id.trim()),
        reason: values.reason,
      }
    : {
        version: values.stable,
        requestId: randomUUID(),
        ...(values.recover ? { supersedes: values.recover } : {}),
      },
);
gh([
  "workflow",
  "run",
  "release-prepare.yml",
  "--ref",
  "main",
  "-f",
  "version=" + ("action" in intent ? "" : intent.version),
  "-f",
  "request_id=" + intent.requestId,
  ...("action" in intent
    ? ["-f", "withdraws=" + intent.withdraws.join(","), "-f", "reason=" + intent.reason]
    : intent.supersedes
      ? ["-f", "supersedes=" + intent.supersedes]
      : []),
]);
console.log("Stable preparation dispatched:", intent.requestId);
