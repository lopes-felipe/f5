import "../../../index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EMPTY_QUEUE_THREAD_STATE } from "../../../nextTurnQueueStore";
import { derivePendingUserInputProgress } from "../../../pendingUserInput";
import type { PendingUserInput } from "../../../session-logic";
import type { SessionPhase } from "../../../types";
import { noteWsConnectionOpened, resetWsConnectionStateForTests } from "../../../wsConnectionState";
import { ComposerPrimaryAction } from "./ComposerPrimaryAction";
import type { ComposerSendControls } from "./composerControls";

afterEach(resetWsConnectionStateForTests);

const pendingQuestion: PendingUserInput = {
  requestId: "question-1" as PendingUserInput["requestId"],
  createdAt: "2026-10-29T00:00:00.000Z",
  questions: [
    {
      id: "tools",
      header: "Tools",
      question: "Which tools should be used?",
      options: [{ label: "A", description: "First option" }],
    },
    {
      id: "scope",
      header: "Scope",
      question: "Which files should change?",
      options: [{ label: "B", description: "Second option" }],
    },
  ],
};

function sendControls(phase: SessionPhase, onInterrupt: () => Promise<void>): ComposerSendControls {
  return {
    onSend: vi.fn(async () => {}),
    onInterrupt,
    phase,
    isConnecting: false,
    isWorking: phase === "running",
    isSendBusy: false,
    hasPendingTurnDispatch: false,
    isPendingTurnDispatchBlocked: false,
    composerSendState: {
      trimmedPrompt: "",
      sendableTerminalContexts: [],
      expiredTerminalContextCount: 0,
      hasSendableContent: false,
    },
    isComposerSendBusy: false,
    composerSendBusyLabel: "Sending",
    revertInProgress: false,
    nextTurnQueueState: EMPTY_QUEUE_THREAD_STATE,
    isServerThread: true,
    isPreparingWorktree: false,
    isComposerImageImportPending: false,
    pendingComposerImageImportCount: 0,
    planImplementationManagedByWorkflow: false,
    canImplementMergeFromChat: false,
    setWorkflowImplementDialogOpen: vi.fn(),
    onImplementPlanInNewThread: vi.fn(async () => {}),
  };
}

async function renderPendingQuestion(phase: SessionPhase) {
  const onInterrupt = vi.fn(async () => {});
  const screen = await render(
    <ComposerPrimaryAction
      prompt=""
      send={sendControls(phase, onInterrupt)}
      mode={{ showPlanFollowUpPrompt: false }}
      pending={{
        pendingUserInputs: [],
        activePendingProgress: derivePendingUserInputProgress(pendingQuestion.questions, {}, 0),
        activePendingIsResponding: false,
        activePendingResolvedAnswers: {},
        onPreviousActivePendingUserInputQuestion: vi.fn(),
      }}
    />,
  );
  return { screen, onInterrupt };
}

describe("ComposerPrimaryAction", () => {
  it("keeps Stop generation beside the answer actions while a running turn awaits input", async () => {
    noteWsConnectionOpened();
    const { screen, onInterrupt } = await renderPendingQuestion("running");
    try {
      await expect
        .element(screen.getByRole("button", { name: "Next question", exact: true }))
        .toBeVisible();
      await screen.getByRole("button", { name: "Stop generation", exact: true }).click();
      expect(onInterrupt).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps Stop generation disabled while the connection is down", async () => {
    const { screen, onInterrupt } = await renderPendingQuestion("running");
    try {
      const stop = screen.getByRole("button", { name: "Stop generation", exact: true });
      await expect.element(stop).toBeVisible();
      await expect.element(stop).toBeDisabled();
      // A plain click waits for the button to become enabled; force it through.
      await stop.click({ force: true });
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not offer Stop generation when no turn is running", async () => {
    noteWsConnectionOpened();
    const { screen } = await renderPendingQuestion("ready");
    try {
      await expect
        .element(screen.getByRole("button", { name: "Next question", exact: true }))
        .toBeVisible();
      expect(document.querySelector('button[aria-label="Stop generation"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
