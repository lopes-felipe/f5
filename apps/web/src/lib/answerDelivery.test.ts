import { describe, expect, it } from "vitest";

import { answerDeliveryDisplayText, parseAnswerDeliveryText } from "./answerDelivery";

describe("parseAnswerDeliveryText", () => {
  it("reads every question's answers in order", () => {
    expect(
      parseAnswerDeliveryText('{"0":{"answers":["Signed in"]},"1":{"answers":["A","B"]}}'),
    ).toEqual(["Signed in", "A", "B"]);
  });

  it("rejects text that is not an answers record", () => {
    expect(parseAnswerDeliveryText("Signed in")).toBeNull();
    expect(parseAnswerDeliveryText("[1]")).toBeNull();
    expect(parseAnswerDeliveryText('{"0":{"answers":[1]}}')).toBeNull();
    expect(parseAnswerDeliveryText('{"0":{"answers":[]}}')).toBeNull();
  });
});

describe("answerDeliveryDisplayText", () => {
  it("shows an answer message's answers instead of its JSON", () => {
    expect(
      answerDeliveryDisplayText({
        id: "answer:cmd",
        text: '{"0":{"answers":["Signed in; Team Keys page open"]},"1":{"answers":["Later"]}}',
      }),
    ).toBe("Signed in; Team Keys page open · Later");
  });

  it("leaves other messages and unparseable answers alone", () => {
    expect(answerDeliveryDisplayText({ id: "msg-1", text: '{"0":{"answers":["A"]}}' })).toBeNull();
    expect(answerDeliveryDisplayText({ id: "answer:cmd", text: "plain text" })).toBeNull();
  });
});
