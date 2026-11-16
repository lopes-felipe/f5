import { CheckIcon, MessageCircleQuestionIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { WorkLogUserInput, WorkLogUserInputQuestion } from "../../session-logic";

function questionCountLabel(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}

/** The adapter's `Question N` fallback says nothing the layout doesn't already. */
function showsHeaderChip(header: string): boolean {
  const trimmed = header.trim();
  return trimmed.length > 0 && !/^question \d+$/i.test(trimmed);
}

function headingFor(userInput: WorkLogUserInput): string {
  const count = userInput.questions.length;
  switch (userInput.state) {
    case "answered":
      return `Asked ${questionCountLabel(count)}`;
    case "pending":
      return `Waiting for your answer · ${questionCountLabel(count)}`;
    case "unanswered":
      return "Questions not answered";
  }
}

/** An agent's questions and the submitted answers, as one timeline card. */
export const UserInputCard = memo(function UserInputCard(props: {
  userInput: WorkLogUserInput;
  timestamp: ReactNode;
}) {
  const { userInput } = props;
  const pending = userInput.state === "pending";
  return (
    <div
      className="rounded-xl border border-border bg-card/50 px-3 py-2.5"
      data-slot="user-input-card"
    >
      <div className="flex min-h-5 items-center gap-2 text-ui">
        {pending ? (
          <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
            <span className="size-1.75 rounded-full bg-warning ring-3 ring-warning/25" />
          </span>
        ) : (
          <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5 shrink-0 text-info" />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium",
            userInput.state === "unanswered" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {headingFor(userInput)}
        </span>
        {props.timestamp}
      </div>
      {pending ? null : (
        <div className="mt-1 space-y-2.5 pl-5.5">
          {userInput.questions.map((question) => (
            <UserInputCardQuestion key={question.id} question={question} />
          ))}
        </div>
      )}
    </div>
  );
});

function UserInputCardQuestion(props: { question: WorkLogUserInputQuestion }) {
  const { question } = props;
  return (
    <div className="min-w-0 pt-1">
      {showsHeaderChip(question.header) ? (
        <p className="text-2xs font-semibold tracking-widest text-muted-foreground uppercase">
          {question.header}
        </p>
      ) : null}
      <p className="text-ui leading-snug wrap-break-word whitespace-pre-wrap text-muted-foreground">
        {question.question}
      </p>
      {question.answers.length > 0 ? (
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Answers">
          {question.answers.map((answer, index) =>
            answer.custom ? (
              <li
                key={`${index}:${answer.text}`}
                className="max-w-full rounded-md bg-secondary px-2 py-0.5 text-ui wrap-break-word text-foreground italic"
              >
                “{answer.text}”
              </li>
            ) : (
              <li
                key={`${index}:${answer.text}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-info/15 px-2 py-0.5 text-ui font-medium wrap-break-word text-foreground"
              >
                <CheckIcon aria-hidden="true" className="size-3 shrink-0 text-info" />
                {answer.text}
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}
