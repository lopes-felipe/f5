import { describe, expect, it } from "vitest";

import { answerDeliveryDisplayText } from "./answerDelivery";

describe("answerDeliveryDisplayText", () => {
  it("shows an answer message's answers instead of its JSON", () => {
    expect(
      answerDeliveryDisplayText({
        id: "answer:cmd",
        text: '{"0":{"answers":["Signed in; Team Keys page open"]},"1":{"answers":["Later"]}}',
      }),
    ).toBe("Signed in; Team Keys page open · Later");
  });

  it("reads a retried answer the same way", () => {
    expect(
      answerDeliveryDisplayText({ id: "answer:cmd#retry", text: '{"0":{"answers":["A"]}}' }),
    ).toBe("A");
  });

  it("leaves other messages and unparseable answers alone", () => {
    expect(answerDeliveryDisplayText({ id: "msg-1", text: '{"0":{"answers":["A"]}}' })).toBeNull();
    expect(answerDeliveryDisplayText({ id: "answer:cmd", text: "plain text" })).toBeNull();
  });
});
