import {
  MobileApproval,
  MobileBootstrap,
  MobilePendingInput,
  MobileThreadTail,
} from "@t3tools/contracts/mobile/v1";
import { Schema } from "effect";

const bootstrap = Schema.decodeUnknownSync(
  Schema.Struct({
    ...MobileBootstrap.fields,
    health: Schema.String,
  }),
);
const tail = Schema.decodeUnknownSync(
  Schema.Struct({
    ...MobileThreadTail.fields,
    approvals: Schema.Array(
      Schema.Struct({ ...MobileApproval.fields, decisions: Schema.Array(Schema.String) }),
    ),
    pendingInputs: Schema.Array(
      Schema.Struct({ ...MobilePendingInput.fields, responseMode: Schema.String }),
    ),
  }),
);

export function decodeMobileBootstrap(raw: unknown): typeof MobileBootstrap.Type {
  const value = bootstrap(raw);
  return { ...value, health: value.health === "ok" ? "ok" : "degraded" };
}

export function decodeMobileTail(raw: unknown): typeof MobileThreadTail.Type {
  const value = tail(raw);
  return {
    ...value,
    approvals: value.approvals.map((approval) => ({
      ...approval,
      decisions: approval.decisions.filter(
        (choice) => choice === "accept" || choice === "decline" || choice === "cancel",
      ),
    })),
    pendingInputs: value.pendingInputs.map((input) => {
      if (input.responseMode === "native" || input.responseMode === "message") {
        return { ...input, responseMode: input.responseMode };
      }
      return { ...input, hostOnly: true, responseMode: "native", questions: [] };
    }),
  };
}
