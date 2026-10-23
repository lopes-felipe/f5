import { ApprovalRequestId, ThreadId, TurnId, type PendingUserInput } from "@t3tools/contracts";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncUserInputPanel } from "./AsyncUserInputPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
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
const twoQuestions: PendingUserInput = {
  ...question,
  requestId: ApprovalRequestId.makeUnsafe("question-2"),
  questions: [
    {
      id: "retry",
      header: "Retry",
      question: "Repeat the check?",
      options: [
        { label: "Ready", description: "Run it now" },
        { label: "Later", description: "Save it for later" },
      ],
    },
    {
      id: "dialog",
      header: "Dialog",
      question: "Did a dialog open?",
      options: [
        { label: "No", description: "Nothing appeared" },
        { label: "Yes", description: "Something opened" },
      ],
    },
  ],
};
describe("async questions", () => {
  beforeEach(() => {
    mocks.dispatch.mockReset().mockResolvedValue({ sequence: 1 });
    mocks.release.mockReset().mockResolvedValue(undefined);
  });
  it("links URLs and files in the question text", async () => {
    const url = "https://accounts.example.com/device?user_code=RTJS-TQGS";
    const linked: PendingUserInput = {
      ...question,
      questions: [
        { ...question.questions[0]!, question: `Open ${url} and check [notes](./notes.md).` },
      ],
    };
    const screen = await render(
      <>
        <AsyncUserInputPanel threadId={threadId} input={linked} cwd="/repo" />
        <ComposerPendingUserInputPanel
          pendingUserInputs={[{ ...linked, responseMode: undefined }]}
          cwd="/repo"
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onSelectOption={() => {}}
          onToggleOption={() => {}}
          onAdvance={() => {}}
        />
      </>,
    );
    try {
      const links = page.getByRole("link", { name: url }).all();
      expect(links).toHaveLength(2);
      for (const link of links) await expect.element(link).toHaveAttribute("href", url);
      expect(screen.container.querySelectorAll(".chat-markdown-file-link")).toHaveLength(2);
    } finally {
      await screen.unmount();
    }
  });
  it("shows an editable prefill and submits an explicitly cleared editor without restoring its old text", async () => {
    const input = {
      ...question,
      questions: [
        {
          id: "editor",
          header: "Edit",
          question: "Edit draft",
          options: [],
          initialAnswer: "Existing draft",
          optional: true,
        },
      ],
    };
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={input} />);
    try {
      const editor = page.getByRole("textbox");
      await expect.element(editor).toHaveValue("Existing draft");
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await editor.fill("");
      await page.getByRole("button", { name: "Send (0/1)", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { editor: { answers: [] } } }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("preserves multiple selected choices and typed answers in one response", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "A", exact: true }).click();
      await page.getByRole("button", { name: "B", exact: true }).click();
      await page.getByRole("button", { name: "Other…" }).click();
      await page.getByRole("textbox", { name: "Other answer: Choose tools" }).fill("Typed detail");
      await page.getByRole("button", { name: "Send", exact: true }).click();
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
  it("steps through questions without auto-sending the last one", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={twoQuestions} />);
    try {
      await expect.element(page.getByText("1/2")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Ready", exact: true }).click();
      await expect.element(page.getByText("Did a dialog open?")).toBeVisible();
      await expect.element(page.getByText("2/2")).toBeVisible();
      await page.getByRole("button", { name: "Go to previous question" }).click();
      await expect.element(page.getByText("Repeat the check?")).toBeVisible();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "No", exact: true }).click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.user-input.respond",
          answers: { retry: { answers: ["Ready"] }, dialog: { answers: ["No"] } },
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("scopes digit shortcuts to the focused panel", async () => {
    const screen = await render(
      <div>
        <textarea aria-label="Composer" />
        <AsyncUserInputPanel threadId={threadId} input={question} />
      </div>,
    );
    try {
      await page.getByRole("textbox", { name: "Composer" }).click();
      await userEvent.keyboard("2");
      await expect
        .element(page.getByRole("button", { name: "B", exact: true }))
        .toHaveAttribute("aria-pressed", "false");
      await page.getByRole("button", { name: "A", exact: true }).click();
      await userEvent.keyboard("2");
      await expect
        .element(page.getByRole("button", { name: "B", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
    } finally {
      await screen.unmount();
    }
  });
  it("answers option-free questions in free text", async () => {
    const freeText: PendingUserInput = {
      ...question,
      questions: [{ id: "why", header: "Reason", question: "Why?", options: [] }],
    };
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={freeText} />);
    try {
      await page.getByRole("textbox", { name: "Other answer: Why?" }).fill("Because");
      await userEvent.keyboard("{Enter}");
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { why: { answers: ["Because"] } } }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("keeps the answer editable after a failed submission", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Offline"));
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "Other…" }).click();
      await page.getByRole("textbox").fill("Keep my draft");
      await page.getByRole("button", { name: "Send", exact: true }).click();
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
  it("keeps digits pressed in a message question out of a blocking question", async () => {
    const onSelectOption = vi.fn();
    const blocking: PendingUserInput = {
      ...twoQuestions,
      requestId: ApprovalRequestId.makeUnsafe("blocking-1"),
      responseMode: undefined,
      questions: [
        {
          id: "keep",
          header: "Keep",
          question: "Keep the branch?",
          options: [
            { label: "Keep", description: "Leave it" },
            { label: "Drop", description: "Delete it" },
          ],
        },
        {
          id: "push",
          header: "Push",
          question: "Push now?",
          options: [{ label: "Push", description: "Push it" }],
        },
      ],
    };
    const screen = await render(
      <div>
        <AsyncUserInputPanel threadId={threadId} input={question} />
        <ComposerPendingUserInputPanel
          pendingUserInputs={[blocking]}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onSelectOption={onSelectOption}
          onToggleOption={vi.fn()}
          onAdvance={vi.fn()}
        />
      </div>,
    );
    try {
      // The composer owns step navigation for blocking questions.
      await expect
        .element(page.getByRole("button", { name: "Go to next question" }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "A", exact: true }).click();
      await userEvent.keyboard("2");
      await expect
        .element(page.getByRole("button", { name: "B", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      // Out of the message question's range: still not the blocking question's digit.
      await userEvent.keyboard("5");
      expect(onSelectOption).not.toHaveBeenCalled();
      (document.activeElement as HTMLElement | null)?.blur();
      await userEvent.keyboard("1");
      expect(onSelectOption).toHaveBeenCalledWith("keep", "Keep");
    } finally {
      await screen.unmount();
    }
  });
  it("keeps keyboard focus in the panel when a digit advances the step", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={twoQuestions} />);
    try {
      (page.getByRole("button", { name: "Ready", exact: true }).element() as HTMLElement).focus();
      await userEvent.keyboard("1");
      await expect.element(page.getByText("2/2")).toBeVisible();
      await userEvent.keyboard("2");
      await expect
        .element(page.getByRole("button", { name: "Yes", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      await expect.element(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });
  it("announces the saved single-select choice when revisiting a step", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={twoQuestions} />);
    try {
      await page.getByRole("button", { name: "Ready", exact: true }).click();
      await expect.element(page.getByText("2/2")).toBeVisible();
      await page.getByRole("button", { name: "Go to previous question" }).click();
      await expect
        .element(page.getByRole("button", { name: "Ready", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
      await expect
        .element(page.getByRole("button", { name: "Later", exact: true }))
        .toHaveAttribute("aria-pressed", "false");
    } finally {
      await screen.unmount();
    }
  });
  it("drops multi-select typed text once Other is closed", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "A", exact: true }).click();
      await page.getByRole("button", { name: "Other…" }).click();
      await page.getByRole("textbox", { name: "Other answer: Choose tools" }).fill("Discarded");
      await page.getByRole("button", { name: "Other…" }).click();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { "0": { answers: ["A"] } } }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("treats a single-select option and Other text as mutually exclusive", async () => {
    const single: PendingUserInput = { ...twoQuestions, questions: [twoQuestions.questions[0]!] };
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={single} />);
    try {
      const ready = page.getByRole("button", { name: "Ready", exact: true });
      await ready.click();
      await page.getByRole("button", { name: "Other…" }).click();
      await expect.element(ready).toHaveAttribute("aria-pressed", "false");
      await page.getByRole("textbox", { name: "Other answer: Repeat the check?" }).fill("Custom");
      await page.getByRole("button", { name: "Later", exact: true }).click();
      await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { retry: { answers: ["Later"] } } }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("keeps Send disabled until every required question is answered", async () => {
    const mixed: PendingUserInput = {
      ...twoQuestions,
      questions: [{ ...twoQuestions.questions[0]!, optional: true }, twoQuestions.questions[1]!],
    };
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={mixed} />);
    try {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      const send = page.getByRole("button", { name: "Send (0/2)" });
      await expect.element(send).toBeDisabled();
      await page.getByRole("button", { name: "No", exact: true }).click();
      await page.getByRole("button", { name: "Send (1/2)" }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          answers: { retry: { answers: [] }, dialog: { answers: ["No"] } },
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("adds a line on Shift+Enter and sends on Enter in the Other field", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "Other…" }).click();
      await userEvent.keyboard("line one{Shift>}{Enter}{/Shift}line two");
      await expect.element(page.getByRole("textbox")).toHaveValue("line one\nline two");
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { "0": { answers: ["line one\nline two"] } } }),
      );
    } finally {
      await screen.unmount();
    }
  });
});
