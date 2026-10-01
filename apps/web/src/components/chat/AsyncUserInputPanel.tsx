import { useState } from "react";
import {
  CommandId,
  type AttachmentUpload,
  type PendingUserInput,
  type ThreadId,
} from "@t3tools/contracts";
import { readNativeApi } from "~/nativeApi";
import { UserInputAttachments } from "./UserInputAttachments";

/** Message questions keep their drafts mounted while the conversation continues. */
export function AsyncUserInputPanel({
  threadId,
  input,
}: {
  threadId: ThreadId;
  input: PendingUserInput;
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
    <section className="mb-2 rounded-lg border border-border p-3" aria-label="Question from agent">
      {input.questions.map((question) => (
        <div key={question.id} className="mb-3">
          <p className="mb-2 text-sm">{question.question}</p>
          <div className="flex flex-wrap gap-2">
            {question.options.map((option) => (
              <button
                key={option.label}
                disabled={busy}
                type="button"
                aria-pressed={answers[question.id]?.includes(option.label) ?? false}
                className="rounded border px-2 py-1 text-xs"
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
            className="mt-2 w-full rounded border bg-transparent p-2 text-sm"
            disabled={busy}
            value={custom[question.id] ?? ""}
            onChange={(event) =>
              setCustom((current) => ({ ...current, [question.id]: event.target.value }))
            }
          />
        </div>
      ))}
      <div className="flex items-center gap-3 text-xs">
        <button type="button" disabled={busy} onClick={() => void resolve(false)}>
          Answer
        </button>
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
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
