import { describe, expect, it } from "vitest";

import {
  asPreSendDeliveryError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderTurnDeliveryError,
} from "../../provider/Errors.ts";
import { toPreSendDeliveryError, toProviderTurnDeliveryError } from "./ProviderCommandReactor.ts";

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

describe("toPreSendDeliveryError", () => {
  it("reports a session that cannot resume as not sent, with the adapter's reason", () => {
    const mapped = toPreSendDeliveryError(
      new ProviderAdapterProcessError({
        provider: "claudeAgent",
        threadId: "thread-1",
        detail:
          "No persisted Claude resume boundary has a complete parent chain. Use Repair transcript.",
      }),
    );
    expect(mapped.certainty).toBe("not_sent");
    expect(mapped.retryable).toBe(false);
    expect(mapped.detail).toBe(
      "No persisted Claude resume boundary has a complete parent chain. Use Repair transcript. This message was not sent.",
    );
  });

  it("keeps typed delivery errors and declared retry hints", () => {
    const typed = new ProviderTurnDeliveryError({
      certainty: "unknown",
      retryable: false,
      detail: "kept",
    });
    expect(toPreSendDeliveryError(typed)).toBe(typed);

    const busy = toPreSendDeliveryError(
      new ProviderAdapterRequestError({
        provider: "claudeAgent",
        method: "session/start",
        detail: "Claude session stopped while preparing the turn. This message was not sent.",
        deliveryCertainty: "not_sent",
        deliveryRetryable: true,
      }),
    );
    expect(busy).toMatchObject({ certainty: "not_sent", retryable: true });
    expect(busy.detail.match(/This message was not sent\./g)).toHaveLength(1);
  });

  it("maps untyped failures to not sent", () => {
    expect(toPreSendDeliveryError(new Error("disk full"))).toMatchObject({
      certainty: "not_sent",
      retryable: false,
      detail: "disk full This message was not sent.",
    });
    expect(asPreSendDeliveryError(undefined).detail).toBe(
      "The provider session could not be prepared. This message was not sent.",
    );
  });
});
