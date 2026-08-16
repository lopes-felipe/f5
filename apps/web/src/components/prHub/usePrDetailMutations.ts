import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type {
  PrHubDetailMutationResult,
  PrHubDetailResult,
  PrHubTimelinePage,
  PrHubUpdateBranchInput,
  PrHubUpdateCommentInput,
  PrHubChangeReviewersInput,
  PrHubSetReactionInput,
  TrackedPullRequest,
} from "@t3tools/contracts";

import { ensureNativeApi } from "../../nativeApi";
import { toastManager } from "../ui/toast";
import { prHubQueryKeys } from "../../lib/prHubReactQuery";
import {
  reconcileTimelineFirstPage,
  updateDetailReaction,
  updateTimelineReaction,
} from "./prDetails.logic";

function mutationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usePrDetailMutations(pr: TrackedPullRequest) {
  const queryClient = useQueryClient();
  const detailKey = prHubQueryKeys.detail(pr.key);
  const timelineKey = prHubQueryKeys.timeline(pr.key);

  const reconcile = (result: PrHubDetailMutationResult) => {
    queryClient.setQueryData(detailKey, result.detail);
    queryClient.setQueryData<InfiniteData<PrHubTimelinePage, string | undefined>>(
      timelineKey,
      (current) => reconcileTimelineFirstPage(current, result.timeline),
    );
  };

  const updateComment = useMutation({
    mutationFn: (input: PrHubUpdateCommentInput) => ensureNativeApi().prHub.updateComment(input),
    onSuccess: (result) => {
      reconcile(result);
      void queryClient.invalidateQueries({ queryKey: timelineKey });
      toastManager.add({ type: "success", title: "Comment updated" });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not update comment",
        description: mutationError(error),
      });
    },
  });

  const setReaction = useMutation({
    mutationFn: (input: PrHubSetReactionInput) => ensureNativeApi().prHub.setReaction(input),
    onMutate: async (input) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: timelineKey }),
      ]);
      const previousDetail = queryClient.getQueryData<PrHubDetailResult>(detailKey);
      const previousTimeline =
        queryClient.getQueryData<InfiniteData<PrHubTimelinePage, string | undefined>>(timelineKey);
      queryClient.setQueryData(detailKey, (current: PrHubDetailResult | undefined) =>
        updateDetailReaction(current, input.subjectId, input.content, input.reacted),
      );
      queryClient.setQueryData(timelineKey, (current) =>
        updateTimelineReaction(
          current as InfiniteData<PrHubTimelinePage, string | undefined> | undefined,
          input.subjectId,
          input.content,
          input.reacted,
        ),
      );
      return { previousDetail, previousTimeline };
    },
    onSuccess: (result) => reconcile(result),
    onError: (error, _input, context) => {
      queryClient.setQueryData(detailKey, context?.previousDetail);
      queryClient.setQueryData(timelineKey, context?.previousTimeline);
      toastManager.add({
        type: "error",
        title: "Could not update reaction",
        description: mutationError(error),
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: timelineKey });
    },
  });

  const changeReviewers = useMutation({
    mutationFn: (input: PrHubChangeReviewersInput) =>
      ensureNativeApi().prHub.changeReviewers(input),
    onSuccess: (result) => {
      reconcile(result);
      toastManager.add({ type: "success", title: "Reviewers updated" });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not update reviewers",
        description: mutationError(error),
      });
    },
  });

  const updateBranch = useMutation({
    mutationFn: (input: PrHubUpdateBranchInput) => ensureNativeApi().prHub.updateBranch(input),
    onSuccess: (result) => {
      reconcile(result);
      void queryClient.invalidateQueries({ queryKey: prHubQueryKeys.files(pr.key) });
      toastManager.add({ type: "success", title: "Pull request branch updated" });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not update branch",
        description: mutationError(error),
      });
    },
  });

  return { updateComment, setReaction, changeReviewers, updateBranch };
}
