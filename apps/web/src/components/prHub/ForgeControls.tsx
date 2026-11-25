import { useState } from "react";
import * as Schema from "effect/Schema";
import type { ForgeMutationPayload, TrackedPullRequest, PrHubDetail } from "@t3tools/contracts";
import { canQueueGitHubAutoMerge } from "@t3tools/shared/forgeCapabilities";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { getPrHubDraftIdentity } from "../../lib/prHubAccount";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { PrCompletionTextarea as Textarea } from "./PrCompletionTextarea";
import { Input } from "../ui/input";

const split = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
export function ForgeComposer({
  pr,
  anchor,
  replyTo,
}: {
  pr: TrackedPullRequest;
  anchor?:
    | { path: string; line: number; side: "old" | "new"; baseOid?: string | undefined }
    | undefined;
  replyTo?: string | undefined;
}) {
  const caps = pr.forgeCapabilities;
  const [body, setBody] = useLocalStorage(
    JSON.stringify(["forgeComposer", getPrHubDraftIdentity(), pr.key, anchor, replyTo]),
    "",
    Schema.String,
  );
  const [verdict, setVerdict] = useState<"comment" | "approve" | "request-changes">("comment");
  if (!caps?.comment && !caps?.review.verdicts.length) return null;
  const payload: ForgeMutationPayload =
    anchor || replyTo || verdict === "comment"
      ? { kind: "comment", body, ...(anchor ?? {}), ...(replyTo ? { replyTo } : {}) }
      : { kind: "review", body, verdict };
  return (
    <section className="space-y-2" aria-label="Comment and review composer">
      {!anchor && !replyTo ? (
        <label className="text-xs">
          Submit as{" "}
          <select
            aria-label="Comment or review"
            value={verdict}
            onChange={(event) => setVerdict(event.target.value as typeof verdict)}
            className="ml-2 rounded border border-border bg-background p-1"
          >
            {caps?.comment ? <option value="comment">Comment</option> : null}
            {caps?.review.verdicts
              .filter((v) => v !== "comment")
              .map((v) => (
                <option key={v} value={v}>
                  {v === "approve" ? "Approve" : "Request changes"}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      <Textarea
        prKey={pr.key}
        aria-label={anchor ? "Inline comment" : "Comment and review text"}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {body.trim() || verdict !== "comment" ? (
        <ForgeOperationPanel
          pr={pr}
          payload={payload}
          label={anchor ? "Inline comment" : replyTo ? "Reply" : "Comment or review"}
          onSucceeded={() => setBody("")}
        />
      ) : null}
    </section>
  );
}
/**
 * The forge's less common writes: a comment or review, any action the forge advertises,
 * labels, and the title. Reviewers are chosen in the Reviewers section of the Overview.
 */
export function ForgeControls({
  pr,
  detail,
}: {
  pr: TrackedPullRequest;
  detail?: Pick<PrHubDetail, "state" | "providerDetails"> | undefined;
}) {
  const caps = pr.forgeCapabilities;
  const [action, setAction] = useState(caps?.actions[0] ?? "close");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("merge");
  const [labels, setLabels] = useState(pr.labels.join(", "));
  const [title, setTitle] = useState(pr.title),
    [body, setBody] = useState("");
  if (!caps || pr.repositoryArchived) return null;
  const actions = caps.actions.filter((action) => {
    if (action === "enable-auto-merge" && detail?.providerDetails.provider === "github")
      return (
        detail.state === "open" &&
        canQueueGitHubAutoMerge(
          detail.providerDetails.autoMergeAllowed,
          detail.providerDetails.mergeStateStatus,
        )
      );
    if (action !== "delete-branch") return true;
    const state = detail?.state ?? pr.state;
    return (
      (state === "merged" || state === "closed") &&
      (pr.provider !== "gitlab" ||
        (detail?.providerDetails.provider === "gitlab" &&
          detail.providerDetails.viewerCanDeleteBranch === true))
    );
  });
  const availableAction = actions.includes(action) ? action : actions[0]!;
  const methods = availableAction === "update-branch" ? caps.updateMethods : caps.mergeMethods;
  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      <ForgeComposer pr={pr} />
      {actions.length ? (
        <section className="space-y-2">
          <label className="text-xs">
            Forge action{" "}
            <select
              aria-label="Forge action"
              value={availableAction}
              onChange={(e) => setAction(e.target.value as typeof action)}
              className="ml-2 rounded border border-border bg-background p-1"
            >
              {actions.map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </label>
          {availableAction === "merge" ||
          availableAction === "update-branch" ||
          availableAction === "enable-auto-merge" ? (
            <select
              aria-label="Forge action method"
              value={methods.includes(method) ? method : methods[0]}
              onChange={(e) => setMethod(e.target.value as typeof method)}
              className="ml-2 rounded border border-border bg-background p-1"
            >
              {methods.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : null}
          <ForgeOperationPanel
            pr={pr}
            payload={{
              kind: "action",
              action: availableAction,
              ...(availableAction === "merge" ||
              availableAction === "update-branch" ||
              availableAction === "enable-auto-merge"
                ? { method: methods.includes(method) ? method : methods[0]! }
                : {}),
            }}
            label="Forge action"
          />
        </section>
      ) : null}
      {caps.labels ? (
        <section className="space-y-2">
          <label className="text-xs">
            Labels{pr.provider === "forgejo" ? " (IDs)" : ""}
            <Input
              aria-label="Forge labels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </label>
          <ForgeOperationPanel
            pr={pr}
            payload={{ kind: "labels", labels: split(labels) }}
            label="Labels"
          />
        </section>
      ) : null}
      {caps.edit.changeRequest ? (
        <details>
          <summary className="cursor-pointer text-sm">Edit pull request</summary>
          <div className="mt-2 space-y-2">
            <Input
              aria-label="Pull request title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              prKey={pr.key}
              aria-label="Pull request description"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <ForgeOperationPanel
              pr={pr}
              payload={{ kind: "edit", title, ...(body.trim() ? { body } : {}) }}
              label="Pull request edit"
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
