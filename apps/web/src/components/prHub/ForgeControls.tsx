import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ensureNativeApi } from "../../nativeApi";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { Button } from "../ui/button";
import * as Schema from "effect/Schema";
import type { ForgeMutationPayload, TrackedPullRequest } from "@t3tools/contracts";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { getPrHubDraftIdentity } from "../../lib/prHubAccount";
import { ForgeOperationPanel } from "./ForgeOperationPanel";
import { Textarea } from "../ui/textarea";
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
  anchor?: { path: string; line: number; side: "old" | "new" } | undefined;
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
export function ForgeControls({ pr }: { pr: TrackedPullRequest }) {
  const caps = pr.forgeCapabilities;
  const [action, setAction] = useState(caps?.actions[0] ?? "close");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("merge");
  const [labels, setLabels] = useState(pr.labels.join(", "));
  const [title, setTitle] = useState(pr.title),
    [body, setBody] = useState("");
  if (!caps || pr.repositoryArchived) return null;
  const methods = action === "update-branch" ? caps.updateMethods : caps.mergeMethods;
  return (
    <div className="space-y-4 rounded-lg border border-border p-3">
      <ForgeComposer pr={pr} />
      {caps.actions.length ? (
        <section className="space-y-2">
          <label className="text-xs">
            Forge action{" "}
            <select
              aria-label="Forge action"
              value={action}
              onChange={(e) => setAction(e.target.value as typeof action)}
              className="ml-2 rounded border border-border bg-background p-1"
            >
              {caps.actions.map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </label>
          {action === "merge" || action === "update-branch" || action === "enable-auto-merge" ? (
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
              action,
              ...(action === "merge" || action === "update-branch" || action === "enable-auto-merge"
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
      {caps.reviewers.request ? <ForgeReviewerPicker pr={pr} /> : null}
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

interface NativeReviewer {
  readonly id: string;
  readonly label: string;
}
const object = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
const rows = (value: unknown): readonly unknown[] =>
  Array.isArray(value)
    ? value
    : Array.isArray(object(value).values)
      ? (object(value).values as unknown[])
      : Array.isArray(object(value).value)
        ? (object(value).value as unknown[])
        : [];
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);
const normalizeReviewer = (
  value: unknown,
  provider: TrackedPullRequest["provider"],
): NativeReviewer | null => {
  const raw = object(value),
    user = object(raw.user ?? value);
  if (raw.role && raw.role !== "REVIEWER") return null;
  const native =
    provider === "github" || provider === "forgejo"
      ? user.login
      : provider === "bitbucket"
        ? user.uuid
        : user.id;
  const id = typeof native === "number" && Number.isFinite(native) ? String(native) : text(native);
  if (!id) return null;
  return {
    id,
    label:
      text(
        user.username ??
          user.login ??
          user.nickname ??
          user.display_name ??
          user.displayName ??
          user.name,
      ) ?? id,
  };
};
function reviewerSet(value: unknown, provider: TrackedPullRequest["provider"]) {
  const response = object(value),
    current = rows(response.currentReviewers);
  const expected = current.filter(
    (value) => !object(value).role || object(value).role === "REVIEWER",
  );
  const existing = expected.map((value) => normalizeReviewer(value, provider));
  const candidates = rows(response.candidates)
    .map((value) => normalizeReviewer(value, provider))
    .filter((value): value is NativeReviewer => value !== null);
  return {
    known: Array.isArray(response.currentReviewers) && existing.every((value) => value !== null),
    current: existing.filter((value): value is NativeReviewer => value !== null),
    candidates,
    candidatesSupported: response.candidatesSupported !== false,
  };
}

export function ForgeReviewerPicker({ pr }: { pr: TrackedPullRequest }) {
  const generation = getPrHubAccountGeneration();
  const query = useQuery({
    queryKey: ["prHub", "reviewerCandidates", generation, pr.key, pr.updatedAt],
    enabled: !!generation,
    queryFn: () =>
      ensureNativeApi().prHub.listReviewerCandidates({
        key: pr.key,
        accountGeneration: generation!,
      }),
    staleTime: 60000,
    retry: false,
  });
  const [selected, setSelected] = useState<readonly string[]>([]),
    [loaded, setLoaded] = useState<unknown>(null),
    [manual, setManual] = useState("");
  const data = query.data === undefined ? null : reviewerSet(query.data, pr.provider);
  useEffect(() => {
    if (query.data !== undefined && loaded !== query.data) {
      const current = reviewerSet(query.data, pr.provider);
      setSelected(current.current.map((value) => value.id));
      setLoaded(query.data);
    }
  }, [query.data, loaded, pr.provider]);
  const options = new Map<string, NativeReviewer>();
  for (const value of [...(data?.current ?? []), ...(data?.candidates ?? [])])
    options.set(value.id, value);
  for (const id of selected) if (!options.has(id)) options.set(id, { id, label: id });
  const ready = data?.known && loaded === query.data;
  return (
    <section className="space-y-2" aria-label="Reviewer selection">
      <p className="text-xs font-medium">Reviewers</p>
      {query.isPending ? (
        <p className="text-xs text-muted-foreground">Loading reviewer identities…</p>
      ) : null}
      {query.isError ? (
        <p role="alert" className="text-xs">
          Could not load reviewer identities. Existing reviewers are preserved.
        </p>
      ) : null}
      {data && !data.known ? (
        <p role="alert" className="text-xs">
          Existing reviewer identities could not be verified. Refresh before changing reviewers.
        </p>
      ) : null}
      {ready ? (
        <>
          <div className="max-h-48 space-y-1 overflow-auto">
            {[...options.values()].map((value) => (
              <label
                key={value.id}
                className="flex items-center gap-2 text-xs"
                title={`Provider ID: ${value.id}`}
              >
                <input
                  type="checkbox"
                  aria-label={`Reviewer ${value.label}`}
                  checked={selected.includes(value.id)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, value.id]
                        : selected.filter((id) => id !== value.id),
                    )
                  }
                />
                {value.label}
              </label>
            ))}
          </div>
          {!data.candidatesSupported ? (
            <div className="flex items-center gap-2">
              <Input
                aria-label="Reviewer provider ID"
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                placeholder="Provider reviewer ID"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!manual.trim() || selected.includes(manual.trim())}
                onClick={() => {
                  setSelected([...selected, manual.trim()]);
                  setManual("");
                }}
              >
                Add reviewer
              </Button>
            </div>
          ) : null}
          {selected.length === 0 ? (
            <p className="text-xs text-muted-foreground">No reviewers selected.</p>
          ) : null}
          <ForgeOperationPanel
            pr={pr}
            payload={{ kind: "reviewers", reviewers: selected }}
            label="Reviewers"
          />
        </>
      ) : null}
    </section>
  );
}
