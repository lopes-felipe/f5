import { useState } from "react";
import {
  CommandId,
  type AttachmentUpload,
  type PendingUserInput,
  type ThreadId,
} from "@t3tools/contracts";
import { readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { COMPOSER_TRAY_PANEL_CLASS_NAME, type ComposerPanelVariant } from "./composer/ComposerTray";
import { UserInputAttachments } from "./UserInputAttachments";

/** Message questions keep their drafts mounted while the conversation continues. */
export function AsyncUserInputPanel({
  threadId,
  input,
  variant = "standalone",
}: {
  threadId: ThreadId;
  input: PendingUserInput;
  variant?: ComposerPanelVariant;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<AttachmentUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
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
                input.questions.map((question) => [
                  question.id,
                  {
                    answers: [
                      ...(answers[question.id] ?? []),
                      ...(custom[question.id]?.trim() ? [custom[question.id]!.trim()] : []),
                    ],
                  },
                ]),
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
      setResolved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  if (resolved) return null;
  return (
    <section
      className={
        variant === "tray"
          ? COMPOSER_TRAY_PANEL_CLASS_NAME
          : "mx-auto mb-2 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card p-3"
      }
      aria-label="Question from agent"
    >
      {input.questions.map((question) => (
        <div key={question.id} className="mb-3">
          <p className="mb-2 text-ui font-medium text-foreground">{question.question}</p>
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => (
              <button
                key={option.label}
                disabled={busy}
                type="button"
                aria-pressed={answers[question.id]?.includes(option.label) ?? false}
                className="h-7 rounded-md border border-border px-2 text-ui text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-pressed:border-primary/60 aria-pressed:bg-primary/10 aria-pressed:text-foreground"
                onClick={() =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: question.multiSelect
                      ? current[question.id]?.includes(option.label)
                        ? current[question.id]!.filter((value) => value !== option.label)
                        : [...(current[question.id] ?? []), option.label]
                      : [option.label],
                  }))
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <textarea
            aria-label={`Answer: ${question.question}`}
            className="mt-2 w-full rounded-md border border-input bg-background p-2 text-ui outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            disabled={busy}
            value={custom[question.id] ?? ""}
            onChange={(event) =>
              setCustom((current) => ({ ...current, [question.id]: event.target.value }))
            }
          />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button type="button" size="sm" disabled={busy} onClick={() => void resolve(false)}>
          Answer
        </Button>
        <UserInputAttachments
          threadId={threadId}
          attachments={attachments}
          onChange={setAttachments}
          disabled={busy}
          onDismiss={() => void resolve(true)}
          onUploadBusyChange={setBusy}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}
