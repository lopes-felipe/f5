import { describe, expect, it } from "vitest";

import {
  answerMessageIdFor,
  answerMessageLinkId,
  formatAnswerDeliveryAnswers,
  nextQueuedMessageId,
  parseAnswerDeliveryRecord,
  parseAnswerDeliveryText,
} from "./answerDelivery";

describe("answer message ids", () => {
  it("keeps the card link across edits and retries", () => {
    const first = answerMessageIdFor("respond-1");
    expect(first).toBe("answer:respond-1");
    const retried = nextQueuedMessageId(first, "uuid-a");
    const editedAgain = nextQueuedMessageId(retried, "uuid-b");
    expect(retried).toBe("answer:respond-1#uuid-a");
    expect(editedAgain).toBe("answer:respond-1#uuid-b");
    expect(answerMessageLinkId(first)).toBe(first);
    expect(answerMessageLinkId(editedAgain)).toBe(first);
  });

  it("leaves other queued messages with the fresh id", () => {
    expect(nextQueuedMessageId("message-1", "uuid-a")).toBe("uuid-a");
    expect(answerMessageLinkId("message-1")).toBeNull();
  });
});

describe("parseAnswerDeliveryRecord", () => {
  it("reads each question's answers", () => {
    expect(
      parseAnswerDeliveryRecord('{"0":{"answers":["Signed in"]},"1":{"answers":["A","B"]}}'),
    ).toEqual({ "0": ["Signed in"], "1": ["A", "B"] });
  });

  it("rejects text that is not an answers record", () => {
    expect(parseAnswerDeliveryRecord("Signed in")).toBeNull();
    expect(parseAnswerDeliveryRecord("[1]")).toBeNull();
    expect(parseAnswerDeliveryRecord('{"0":{"answers":[1]}}')).toBeNull();
    expect(parseAnswerDeliveryRecord('{"0":{"answers":[]}}')).toBeNull();
  });
});

describe("parseAnswerDeliveryText", () => {
  it("flattens the answers in delivery order and formats them on one line", () => {
    const answers = parseAnswerDeliveryText('{"0":{"answers":["A"]},"1":{"answers":["B","C"]}}');
    expect(answers).toEqual(["A", "B", "C"]);
    expect(formatAnswerDeliveryAnswers(answers ?? [])).toBe("A · B · C");
  });
});
