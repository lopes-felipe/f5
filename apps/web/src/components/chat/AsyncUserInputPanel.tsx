import { useState } from "react";
import {
  CommandId,
  type AttachmentUpload,
  type PendingUserInput,
  type ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";
import { readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { COMPOSER_TRAY_PANEL_CLASS_NAME, type ComposerPanelVariant } from "./composer/ComposerTray";
import { UserInputAttachments } from "./UserInputAttachments";
import { UserInputQuestionStep } from "./UserInputQuestionStep";

/** Message questions keep their drafts mounted while the conversation continues. */
export function AsyncUserInputPanel({
  threadId,
  input,
  cwd,
  variant = "standalone",
}: {
  threadId: ThreadId;
  input: PendingUserInput;
  cwd?: string | undefined;
  variant?: ComposerPanelVariant;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      input.questions.flatMap((question) =>
        question.initialAnswer === undefined ? [] : [[question.id, question.initialAnswer]],
      ),
    ),
  );
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      input.questions
        .filter((question) => question.initialAnswer !== undefined)
        .map((question) => [question.id, true]),
    ),
  );
  const [questionIndex, setQuestionIndex] = useState(0);
  const [attachments, setAttachments] = useState<AttachmentUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  const questions = input.questions;
  const activeIndex = Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[activeIndex];
  const isLastQuestion = activeIndex >= questions.length - 1;
  // Typed text counts only while its field is open; options-free questions always are.
  const customTextFor = (question: UserInputQuestion) =>
    customOpen[question.id] || question.options.length === 0
      ? (custom[question.id]?.trim() ?? "")
      : "";
  const answerFor = (question: UserInputQuestion) => {
    const text = customTextFor(question);
    return [...(answers[question.id] ?? []), ...(text ? [text] : [])];
  };
  const isAnswered = (question: UserInputQuestion) => answerFor(question).length > 0;
  const canSend = questions.every((question) => question.optional || isAnswered(question));
  const canAdvance =
    activeQuestion !== undefined &&
    (activeQuestion.optional === true || isAnswered(activeQuestion));
  const hasOptionalQuestion = questions.some((question) => question.optional);
  const answeredCount = questions.filter(isAnswered).length;

  const goTo = (index: number) =>
    setQuestionIndex(Math.max(0, Math.min(index, questions.length - 1)));

  const resolve = async (dismissed: boolean) => {
    const api = readNativeApi();
    if (!api || busy || resolved) return;
    setBusy(true);
    setError(null);
    try {
      const base = {
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId,
        requestId: input.requestId,
        createdAt: new Date().toISOString(),
      };
      if (dismissed && attachments.length) {
        await api.attachments.releaseUploads({
          threadId,
          uploadIds: attachments.map((attachment) => attachment.uploadId),
        });
        setAttachments([]);
      }
      await api.orchestration.dispatchCommand(
        dismissed
          ? { ...base, type: "thread.user-input.dismiss" }
          : {
              ...base,
              type: "thread.user-input.respond",
              answers: Object.fromEntries(
                questions.map((question) => [question.id, { answers: answerFor(question) }]),
              ),
              attachments: attachments.map((attachment) => ({
                type: "upload" as const,
                uploadId: attachment.uploadId,
              })),
            },
      );
      setAttachments([]);
      setAnswers({});
      setCustom({});
      setCustomOpen({});
      setResolved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const primaryAction = () => {
    if (busy) return;
    if (isLastQuestion) {
      if (canSend) void resolve(false);
      return;
    }
    if (canAdvance) goTo(activeIndex + 1);
  };

  if (resolved) return null;

  const primaryLabel = isLastQuestion
    ? hasOptionalQuestion
      ? `Send (${answeredCount}/${questions.length})`
      : "Send"
    : "Next";
  const footer = (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <UserInputAttachments
        threadId={threadId}
        attachments={attachments}
        onChange={setAttachments}
        disabled={busy}
        onUploadBusyChange={setBusy}
      />
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void resolve(true)}
        >
          Dismiss
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || (isLastQuestion ? !canSend : !canAdvance)}
          onClick={primaryAction}
        >
          {primaryLabel}
          {isLastQuestion ? null : <ArrowRightIcon aria-hidden="true" className="size-3.5" />}
        </Button>
      </div>
    </div>
  );

  return (
    <section
      className={
        variant === "tray"
          ? COMPOSER_TRAY_PANEL_CLASS_NAME
          : "mx-auto mb-2 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card p-3"
      }
      aria-label="Question from agent"
    >
      {activeQuestion ? (
        <UserInputQuestionStep
          question={activeQuestion}
          cwd={cwd}
          questionIndex={activeIndex}
          questionCount={questions.length}
          selectedOptionLabels={answers[activeQuestion.id] ?? []}
          disabled={busy}
          customMode="inline"
          shortcutScope="panel"
          suppressAutoSubmit
          customAnswer={custom[activeQuestion.id] ?? ""}
          customOpen={customOpen[activeQuestion.id] ?? false}
          onCustomOpenChange={(open) => {
            setCustomOpen((current) => ({ ...current, [activeQuestion.id]: open }));
            // Single-select answers are either an option or the typed text.
            if (open && !activeQuestion.multiSelect) {
              setAnswers((current) => ({ ...current, [activeQuestion.id]: [] }));
            }
          }}
          onCustomAnswerChange={(value) =>
            setCustom((current) => ({ ...current, [activeQuestion.id]: value }))
          }
          onCustomSubmit={primaryAction}
          onSelectOption={(label) => {
            setAnswers((current) => ({ ...current, [activeQuestion.id]: [label] }));
            setCustomOpen((current) => ({ ...current, [activeQuestion.id]: false }));
            setCustom((current) => ({ ...current, [activeQuestion.id]: "" }));
          }}
          onToggleOption={(label) =>
            setAnswers((current) => {
              const selected = current[activeQuestion.id] ?? [];
              return {
                ...current,
                [activeQuestion.id]: selected.includes(label)
                  ? selected.filter((value) => value !== label)
                  : [...selected, label],
              };
            })
          }
          onAdvance={() => goTo(activeIndex + 1)}
          onBack={() => goTo(activeIndex - 1)}
          onForward={canAdvance && !isLastQuestion ? () => goTo(activeIndex + 1) : undefined}
          footer={footer}
        />
      ) : (
        footer
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}
