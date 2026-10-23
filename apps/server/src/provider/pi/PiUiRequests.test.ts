import { expect, it } from "vitest";
import { PiUiRequests } from "./PiUiRequests.ts";

const event = {
  type: "extension_ui_request",
  id: "native-1",
  method: "confirm",
  title: "Allow bash?",
  message: "npm run build",
};
it("isolates responses to the live generation and accepts each request once", () => {
  const requests = new PiUiRequests("generation-1");
  expect(requests.open(event, "host-1", 100, "turn-1").type).toBe("opened");
  expect(
    requests.answer({
      requestId: "host-1",
      generation: "generation-0",
      now: 101,
      decision: "accept",
    }),
  ).toBeNull();
  expect(requests.size).toBe(1);
  expect(
    requests.answer({
      requestId: "host-1",
      generation: "generation-1",
      now: 101,
      decision: "accept",
    }),
  ).toEqual({
    record: { type: "extension_ui_response", id: "native-1", confirmed: true },
    expired: false,
  });
  expect(
    requests.answer({
      requestId: "host-1",
      generation: "generation-1",
      now: 101,
      decision: "accept",
    }),
  ).toBeNull();
});
it("cancels expired dialogs both on their timer and when a late answer races the timer", () => {
  const requests = new PiUiRequests("generation-1");
  const opened = requests.open({ ...event, timeout: 10 }, "host-1", 100);
  if (opened.type !== "opened") throw new Error("Expected pending dialog.");
  expect(requests.expire(opened.request, 109)).toBeUndefined();
  expect(
    requests.answer({
      requestId: "host-1",
      generation: "generation-1",
      now: 110,
      decision: "accept",
    }),
  ).toMatchObject({ expired: true, record: { cancelled: true } });
  expect(requests.expire(opened.request, 110)).toBeUndefined();
});
it("does not let a stale expiration cancel a new request with the same external ID", () => {
  const requests = new PiUiRequests("generation-1");
  const old = requests.open({ ...event, timeout: 10 }, "host-1", 100);
  if (old.type !== "opened") throw new Error("Expected pending dialog.");
  requests.cancelAll();
  expect(requests.open({ ...event, id: "native-2", timeout: 100 }, "host-1", 100).type).toBe(
    "opened",
  );
  expect(requests.expire(old.request, 150)).toBeUndefined();
  expect(requests.size).toBe(1);
});
it("preserves Pi's zero-timeout convention and cancels negative durations immediately", () => {
  const requests = new PiUiRequests("generation-1");
  const opened = requests.open({ ...event, timeout: 0 }, "host-1", 100);
  expect(opened.type === "opened" && opened.request.expiresAt).toBeNull();
  expect(requests.open({ ...event, id: "negative", timeout: -1 }, "host-2", 100)).toMatchObject({
    type: "cancelled",
    record: { cancelled: true },
  });
});
it("distinguishes an empty editor answer from dismissal and retains prefill metadata", () => {
  const requests = new PiUiRequests("generation-1");
  const opened = requests.open(
    { ...event, method: "editor", prefill: "Existing draft" },
    "host-1",
    100,
  );
  expect(opened.type === "opened" && opened.request.prefill).toBe("Existing draft");
  expect(opened.type === "opened" && opened.request.question).toMatchObject({
    initialAnswer: "Existing draft",
    optional: true,
  });
  expect(
    requests.answer({
      requestId: "host-1",
      generation: "generation-1",
      now: 101,
      answer: { answers: [] },
    }),
  ).toMatchObject({ record: { value: "" } });
  requests.open({ ...event, method: "input" }, "host-2", 100);
  expect(
    requests.answer({ requestId: "host-2", generation: "generation-1", now: 101 }),
  ).toMatchObject({ record: { cancelled: true } });
});
it("maps unambiguous UI option labels back to native values, including duplicates and blank options", () => {
  const requests = new PiUiRequests("generation-1");
  const opened = requests.open(
    { ...event, method: "select", options: ["", "same", "same"] },
    "host-1",
    100,
  );
  if (opened.type !== "opened") throw new Error("Expected pending dialog.");
  expect(opened.request.question?.options.map((option) => option.label)).toEqual([
    "1. Empty value",
    "2. same",
    "3. same",
  ]);
  expect(
    requests.answer({
      requestId: "host-1",
      generation: "generation-1",
      now: 101,
      answer: ["1. Empty value"],
    }),
  ).toMatchObject({ record: { value: "" } });
});
it("cancels only dialogs owned by the completed turn, and all remaining dialogs at shutdown", () => {
  const requests = new PiUiRequests("generation-1");
  requests.open(event, "host-1", 100, "turn-1");
  requests.open({ ...event, id: "native-2" }, "host-2", 100, "turn-2");
  expect(requests.cancelTurn("turn-1")).toEqual([
    { type: "extension_ui_response", id: "native-1", cancelled: true },
  ]);
  expect(requests.size).toBe(1);
  expect(requests.cancelAll()).toEqual([
    { type: "extension_ui_response", id: "native-2", cancelled: true },
  ]);
});
it("bounds pending dialogs and rejects reused native IDs", () => {
  const requests = new PiUiRequests("generation-1");
  for (let index = 0; index < 64; index++)
    expect(requests.open({ ...event, id: String(index) }, `host-${index}`, 100).type).toBe(
      "opened",
    );
  expect(requests.open({ ...event, id: "excess" }, "host-excess", 100).type).toBe("cancelled");
  expect(requests.size).toBe(64);
  expect(requests.open({ ...event, id: "0" }, "new-host", 100).type).toBe("protocol-error");
});
