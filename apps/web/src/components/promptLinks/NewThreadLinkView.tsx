import type { ProjectFindByRepositoryResult, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  parseNewThreadLink,
  promptLinkPullRequestUrl,
  promptLinkRepositoryUrl,
  type NewThreadLink,
  type PromptLinkPullRequest,
} from "@t3tools/shared/promptLinks";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCreateProjectBackedDraftThread } from "~/hooks/useCreateProjectBackedDraftThread";
import { useStartScratchThread } from "~/hooks/useStartScratchThread";
import { useStartupReady } from "~/lib/startupReady";
import { getMostRecentProject } from "~/lib/threadOrdering";
import { newCommandId, newThreadId } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useThreadSummaries } from "~/threadSelectors";
import { useServerMutationsAvailable } from "~/wsConnectionState";

import { openProjectCloneDialog } from "../ProjectCloneController";
import { resolvePrF5ModelSelection } from "../prHub/prF5Thread";
import { Button } from "../ui/button";
import { placeLinkedPrompt, resolveLinkedModel } from "./linkedPrompt";

type NewLink = Extract<NewThreadLink, { kind: "new" }>;
type PullRequestLink = Extract<NewThreadLink, { kind: "pull-request" }>;
type LinkedProject = ProjectFindByRepositoryResult[number];

type LinkState =
  | { readonly kind: "opening" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "missing-repository"; readonly link: NewThreadLink }
  | {
      readonly kind: "choose-thread";
      readonly link: PullRequestLink;
      readonly threads: ReadonlyArray<{ threadId: ThreadId; title: string }>;
    }
  | {
      readonly kind: "confirm-checkout";
      readonly link: PullRequestLink;
      readonly project: LinkedProject;
    };

interface Operation {
  readonly current: () => boolean;
  readonly setState: (state: LinkState) => void;
}

const linkRepository = (link: NewThreadLink) =>
  link.kind === "new" ? link.repository : link.pullRequest;

type MostRecentInputs = Parameters<typeof getMostRecentProject>;
interface ActivityInputs {
  readonly threads: MostRecentInputs[1];
  readonly planningWorkflows: MostRecentInputs[2];
  readonly codeReviewWorkflows: MostRecentInputs[3];
  readonly investigationWorkflows: MostRecentInputs[4];
}

/** The matching project the user worked in most recently; the server's order breaks ties. */
function mostRecentlyUsed(
  matches: ProjectFindByRepositoryResult,
  activity: ActivityInputs,
): LinkedProject | undefined {
  const ids = new Set(matches.map((match) => match.projectId));
  const recent = getMostRecentProject(
    useStore.getState().projects.filter((project) => ids.has(project.id)),
    activity.threads,
    activity.planningWorkflows,
    activity.codeReviewWorkflows,
    activity.investigationWorkflows,
  );
  return matches.find((match) => match.projectId === recent?.id) ?? matches[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

/** Prepares the pull request in its own worktree and creates a thread there. Nothing is sent. */
async function openPullRequestThread(
  project: LinkedProject,
  pullRequest: PromptLinkPullRequest,
): Promise<ThreadId> {
  const api = ensureNativeApi();
  const url = promptLinkPullRequestUrl(pullRequest);
  // Read first: failing after the worktree exists would leave it without a thread.
  const config = await api.server.getConfig();
  const [prepared, peek] = await Promise.all([
    api.git.preparePullRequestThread({
      cwd: project.workspaceRoot,
      reference: url,
      mode: "worktree",
      // The pull request may come from a fork, and the user only agreed to a checkout.
      runSetupScript: false,
    }),
    api.prHub.peek({ url }).catch(() => null),
  ]);
  if (!prepared.worktreePath) {
    throw new Error("F5 did not create an isolated worktree for this pull request.");
  }
  const storeProject = useStore.getState().projects.find((entry) => entry.id === project.projectId);
  const { model, modelSelection } = resolvePrF5ModelSelection(
    config.providers,
    storeProject?.model ?? "",
  );
  const title = peek?.title ?? prepared.pullRequest.title;
  const threadId = newThreadId();
  await api.orchestration.dispatchCommand({
    type: "thread.create",
    commandId: newCommandId(),
    threadId,
    projectId: project.projectId,
    title: `PR #${pullRequest.number}: ${title}`,
    pullRequest: {
      provider: "github",
      host: "github.com",
      repository: `${pullRequest.owner}/${pullRequest.name}`,
      number: pullRequest.number,
      title,
      url,
    },
    model,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: prepared.branch,
    worktreePath: prepared.worktreePath,
    createdAt: new Date().toISOString(),
  });
  return threadId;
}

/**
 * Opens `f5://new?…` links: finds the project the link names, or offers to clone it, then puts
 * the prompt in a new draft. Pull request links open the pull request's thread, or check it out
 * in a new worktree once the user confirms. A link never sends a message.
 */
export function NewThreadLinkView({
  search,
  delivery = null,
}: {
  readonly search: string;
  /** Marks one opening of the link, so opening the same link again is handled again. */
  readonly delivery?: string | null;
}) {
  const navigate = useNavigate();
  const createDraftThread = useCreateProjectBackedDraftThread();
  const startScratchThread = useStartScratchThread();
  const [state, setState] = useState<LinkState>({ kind: "opening" });
  const [busy, setBusy] = useState(false);
  const activityInputs: ActivityInputs = {
    threads: useThreadSummaries(),
    planningWorkflows: useStore((store) => store.planningWorkflows),
    codeReviewWorkflows: useStore((store) => store.codeReviewWorkflows),
    investigationWorkflows: useStore((store) => store.investigationWorkflows),
  };
  // Read when the link resolves, so new activity does not reopen the link.
  const activity = useRef(activityInputs);
  useEffect(() => {
    activity.current = activityInputs;
  });

  // Each operation checks that it is still the latest one, and that the view is still mounted,
  // before it navigates, changes a draft or updates the screen. Work for a link the user has
  // since replaced, or left, ends quietly.
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const begin = useCallback((): Operation => {
    const id = ++generation.current;
    const current = () => mounted.current && generation.current === id;
    return {
      current,
      setState: (next) => {
        if (current()) setState(next);
      },
    };
  }, []);

  const openDraft = useCallback(
    async (operation: Operation, link: NewLink, projectId: ProjectId | null) => {
      const providers =
        link.provider === null
          ? []
          : await ensureNativeApi()
              .server.getConfig()
              .then((config) => config.providers)
              .catch(() => []);
      if (!operation.current()) return;
      // Navigating unmounts this view, so the draft is created in place, filled, and only then
      // opened.
      const stay = { canNavigate: () => false };
      const created =
        projectId === null
          ? await startScratchThread(stay)
          : await createDraftThread(projectId, stay);
      if (!created) {
        operation.setState({
          kind: "failed",
          message: "F5 could not create a thread for this prompt.",
        });
        return;
      }
      if (!operation.current()) return;
      const { selection, note } = resolveLinkedModel(link, providers);
      placeLinkedPrompt(created.threadId, link.prompt, { notes: note ? [note] : [], selection });
      await navigate({ to: "/$threadId", params: { threadId: created.threadId } });
    },
    [createDraftThread, navigate, startScratchThread],
  );

  const showThread = useCallback(
    async (operation: Operation, threadId: ThreadId, link: PullRequestLink) => {
      if (!operation.current()) return;
      await navigate({ to: "/$threadId", params: { threadId } });
      if (link.prompt) placeLinkedPrompt(threadId, link.prompt);
    },
    [navigate],
  );

  const openInProject = useCallback(
    async (operation: Operation, link: NewThreadLink, project: LinkedProject) => {
      if (link.kind === "new") return openDraft(operation, link, project.projectId);
      // A checkout runs the pull request's own agent settings and hooks once the user sends a
      // message, so a link never checks out code from outside the repository.
      const { changeRequest } = await ensureNativeApi().git.resolvePullRequest({
        cwd: project.workspaceRoot,
        reference: promptLinkPullRequestUrl(link.pullRequest),
      });
      if (changeRequest?.isCrossRepository !== false) {
        return operation.setState({
          kind: "failed",
          message: `Pull request #${link.pullRequest.number} comes from a fork, and links only check out pull requests from the repository itself. Review its code before you check it out yourself.`,
        });
      }
      operation.setState({ kind: "confirm-checkout", link, project });
    },
    [openDraft],
  );

  const resolveProject = useCallback(
    async (operation: Operation, link: NewThreadLink) => {
      const repository = linkRepository(link);
      if (repository === null) {
        if (link.kind === "new") await openDraft(operation, link, null);
        return;
      }
      const projects = await ensureNativeApi().projects.findByRepository({
        owner: repository.owner,
        name: repository.name,
      });
      if (!operation.current()) return;
      const project = mostRecentlyUsed(projects, activity.current);
      if (project) await openInProject(operation, link, project);
      else operation.setState({ kind: "missing-repository", link });
    },
    [openDraft, openInProject],
  );

  // A cold start opened by the link renders this before the server connection has synchronized,
  // and the server refuses changes until then.
  const startupReady = useStartupReady();
  const mutationsAvailable = useServerMutationsAvailable();
  const ready = startupReady && mutationsAvailable;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    // Refs survive StrictMode's repeated effects, so one opening of a link opens one thread.
    const key = `${delivery ?? ""}\n${search}`;
    if (handled.current === key) return;
    handled.current = key;
    const operation = begin();
    const parsed = parseNewThreadLink(search);
    if (!parsed.ok) {
      operation.setState({ kind: "failed", message: parsed.error });
      return;
    }
    const link = parsed.value;
    operation.setState({ kind: "opening" });
    void (async () => {
      if (link.kind === "pull-request") {
        const key = formatSourceControlPullRequestKey({
          provider: "github",
          host: "github.com",
          repository: `${link.pullRequest.owner}/${link.pullRequest.name}`,
          number: link.pullRequest.number,
        });
        // A failed lookup is reported, not read as "no threads", which would open a duplicate.
        const threads = await ensureNativeApi().prHub.getThreadsForPr({ key });
        if (threads.length === 1) return showThread(operation, threads[0]!.threadId, link);
        if (threads.length > 1) return operation.setState({ kind: "choose-thread", link, threads });
      }
      await resolveProject(operation, link);
    })().catch((error: unknown) =>
      operation.setState({ kind: "failed", message: errorMessage(error) }),
    );
  }, [begin, delivery, ready, resolveProject, search, showThread]);

  const run = (task: (operation: Operation) => Promise<unknown>) => {
    const operation = begin();
    setBusy(true);
    void task(operation)
      .catch((error: unknown) =>
        operation.setState({ kind: "failed", message: errorMessage(error) }),
      )
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-8 text-sm">
      <LinkStateBody
        state={state}
        busy={busy}
        onThread={(link, threadId) => run((operation) => showThread(operation, threadId, link))}
        onCheckout={(link, project) =>
          run(async (operation) =>
            showThread(operation, await openPullRequestThread(project, link.pullRequest), link),
          )
        }
        onWithoutProject={(link) => run((operation) => openDraft(operation, link, null))}
      />
    </div>
  );
}

function LinkStateBody(props: {
  readonly state: LinkState;
  readonly busy: boolean;
  readonly onThread: (link: PullRequestLink, threadId: ThreadId) => void;
  readonly onCheckout: (link: PullRequestLink, project: LinkedProject) => void;
  readonly onWithoutProject: (link: NewLink) => void;
}) {
  const { state, busy } = props;
  switch (state.kind) {
    case "opening":
      return <p className="text-muted-foreground">Opening the link…</p>;
    case "failed":
      return (
        <>
          <h1 className="text-base font-medium">F5 could not open this link</h1>
          <p role="alert" className="text-muted-foreground">
            {state.message}
          </p>
        </>
      );
    case "choose-thread":
      return (
        <>
          <h1 className="text-base font-medium">Choose a thread for this pull request</h1>
          <ul className="flex flex-col gap-2">
            {state.threads.map((thread) => (
              <li key={thread.threadId}>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  disabled={busy}
                  onClick={() => props.onThread(state.link, thread.threadId)}
                >
                  {thread.title}
                </Button>
              </li>
            ))}
          </ul>
        </>
      );
    case "missing-repository": {
      const repository = linkRepository(state.link)!;
      const url = promptLinkRepositoryUrl(repository);
      const link = state.link;
      return (
        <>
          <h1 className="text-base font-medium">
            No project here uses {repository.owner}/{repository.name}
          </h1>
          <p className="text-muted-foreground">
            Clone it, then open this link again when the clone finishes.
          </p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => openProjectCloneDialog("", url)}>
              Clone {url}
            </Button>
            {link.kind === "new" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => props.onWithoutProject(link)}
              >
                Use without a project
              </Button>
            )}
          </div>
        </>
      );
    }
    case "confirm-checkout": {
      const { link, project } = state;
      return (
        <>
          <h1 className="text-base font-medium">
            Check out pull request #{link.pullRequest.number}?
          </h1>
          <p className="text-muted-foreground">
            F5 creates a new worktree of {project.title} for{" "}
            {promptLinkPullRequestUrl(link.pullRequest)} and opens a thread there. The project's
            setup script does not run, but the agent uses the pull request's own files, including
            its agent settings. Check out only pull requests you trust.
          </p>
          <div>
            <Button disabled={busy} onClick={() => props.onCheckout(link, project)}>
              {busy ? "Checking out…" : "Check out in a new worktree"}
            </Button>
          </div>
        </>
      );
    }
  }
}
