import { describe, expect, it } from "vitest";

import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { toProviderTurnDeliveryError } from "./ProviderCommandReactor.ts";

describe("toProviderTurnDeliveryError", () => {
  it("treats an adapter request failure without proof as ambiguous", () => {
    const mapped = toProviderTurnDeliveryError(
      new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "turn/start",
        detail: "Claude runtime stream failed.",
      }),
    );
    expect(mapped.certainty).toBe("unknown");
    expect(mapped.retryable).toBe(false);
  });

  it("keeps an adapter's not-sent proof and retry decision", () => {
    const rejected = toProviderTurnDeliveryError(
      new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "turn/start",
        detail: "Claude could not load the saved conversation, so this message was not sent.",
        deliveryCertainty: "not_sent",
        deliveryRetryable: false,
      }),
    );
    expect(rejected.certainty).toBe("not_sent");
    expect(rejected.retryable).toBe(false);
    expect(rejected.detail).toContain("was not sent");

    const stopped = toProviderTurnDeliveryError({
      cause: new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "turn/start",
        detail: "Claude session stopped while preparing the turn.",
        deliveryCertainty: "not_sent",
        deliveryRetryable: true,
      }),
    });
    expect(stopped.certainty).toBe("not_sent");
    expect(stopped.retryable).toBe(true);
  });
});
