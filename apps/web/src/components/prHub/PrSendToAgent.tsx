import { useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import type { PrHubLocalCheckoutCandidate, ThreadId, TrackedPullRequest } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { useComposerDraftStore } from "../../composerDraftStore";
import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { buildPrCommentComposerPrompt, createPrF5Thread } from "./prF5Thread";
import { Button } from "../ui/button";

export function PrSendToAgent({
  pr,
  body,
  path,
  line,
}: {
  pr: TrackedPullRequest;
  body: string;
  path?: string | null | undefined;
  line?: number | null | undefined;
}) {
  const router = useRouter({ warn: false });
  const operationId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [threads, setThreads] = useState<readonly { threadId: ThreadId; title: string }[] | null>(
    null,
  );
  const [candidates, setCandidates] = useState<readonly PrHubLocalCheckoutCandidate[] | null>(null);
  const [selection, setSelection] = useState("");
  async function send() {
    setBusy(true);
    setError(null);
    try {
      const api = ensureNativeApi();
      const available = threads ?? (await api.prHub.getThreadsForPr({ key: pr.key }));
      setThreads(available);
      let threadId =
        available.length === 1
          ? available[0]!.threadId
          : available.find((t) => t.threadId === selection)?.threadId;
      if (!threadId) {
        if (available.length > 1) return;
        const projects =
          candidates ??
          (await api.prHub.listLocalCheckoutCandidates({
            key: pr.key,
            accountGeneration: getPrHubAccountGeneration(),
          }));
        setCandidates(projects);
        const candidate =
          projects.length === 1 ? projects[0] : projects.find((v) => v.projectId === selection);
        if (!candidate) {
          if (projects.length === 0)
            throw new Error(
              "Add a local project for this pull request before preparing an agent prompt.",
            );
          return;
        }
        const project = useStore.getState().projects.find((v) => v.id === candidate.projectId);
        const config = await api.server.getConfig();
        threadId = (
          await createPrF5Thread({
            api,
            candidate,
            pr,
            intent: "open",
            preferredModel: project?.model ?? "",
            providers: config.providers,
          })
        ).threadId;
      }
      useComposerDraftStore
        .getState()
        .placeRecoveredPrompt(
          threadId,
          operationId.current,
          buildPrCommentComposerPrompt({ pr, body, path, line }),
          "append",
        );
      await router?.navigate({ to: "/$threadId", params: { threadId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare the agent prompt.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-1">
      {threads && threads.length > 1 ? (
        <select
          aria-label="F5 thread for comment"
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
        >
          <option value="">Choose F5 thread</option>
          {threads.map((t) => (
            <option key={t.threadId} value={t.threadId}>
              {t.title}
            </option>
          ))}
        </select>
      ) : null}
      {candidates && candidates.length > 1 ? (
        <select
          aria-label="F5 project for comment"
          value={selection}
          onChange={(e) => setSelection(e.target.value)}
        >
          <option value="">Choose local project</option>
          {candidates.map((v) => (
            <option key={v.projectId} value={v.projectId}>
              {v.projectTitle}
            </option>
          ))}
        </select>
      ) : null}
      <Button
        size="xs"
        variant="outline"
        disabled={busy || !body.trim()}
        onClick={() => void send()}
      >
        {busy ? "Preparing prompt…" : "Send to agent"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
