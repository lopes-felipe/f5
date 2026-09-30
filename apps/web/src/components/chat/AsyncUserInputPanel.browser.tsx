import { ApprovalRequestId, ThreadId, TurnId, type PendingUserInput } from "@t3tools/contracts";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncUserInputPanel } from "./AsyncUserInputPanel";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), release: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: mocks.dispatch },
    attachments: { releaseUploads: mocks.release },
  }),
}));
const threadId = ThreadId.makeUnsafe("questions-thread");
const question: PendingUserInput = {
  requestId: ApprovalRequestId.makeUnsafe("question-1"),
  turnId: TurnId.makeUnsafe("finished-turn"),
  createdAt: "2026-09-30T12:00:00.000Z",
  responseMode: "message",
  questions: [
    {
      id: "0",
      header: "Tools",
      question: "Choose tools",
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
      multiSelect: true,
    },
  ],
};
describe("async questions", () => {
  beforeEach(() => {
    mocks.dispatch.mockReset().mockResolvedValue({ sequence: 1 });
    mocks.release.mockReset().mockResolvedValue(undefined);
  });
  it("preserves multiple selected choices and typed answers in one response", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "A", exact: true }).click();
      await page.getByRole("button", { name: "B", exact: true }).click();
      await page.getByRole("textbox", { name: "Answer: Choose tools" }).fill("Typed detail");
      await page.getByRole("button", { name: "Answer", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.user-input.respond",
          requestId: question.requestId,
          answers: { "0": { answers: ["A", "B", "Typed detail"] } },
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("keeps the answer editable after a failed submission", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Offline"));
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("textbox").fill("Keep my draft");
      await page.getByRole("button", { name: "Answer", exact: true }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Offline");
      await expect.element(page.getByRole("textbox")).toHaveValue("Keep my draft");
    } finally {
      await screen.unmount();
    }
  });
  it("dismisses a question without submitting an answer", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.user-input.dismiss",
          requestId: question.requestId,
        }),
      );
      expect(mocks.dispatch.mock.calls[0]?.[0]).not.toHaveProperty("answers");
    } finally {
      await screen.unmount();
    }
  });
});
