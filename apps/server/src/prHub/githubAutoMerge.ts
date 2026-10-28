import { canQueueGitHubAutoMerge } from "@t3tools/shared/forgeCapabilities";

export const GITHUB_AUTO_MERGE_QUERY = `query F5AutoMergeAvailability($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    autoMergeAllowed viewerPermission
    pullRequest(number:$number){ state mergeStateStatus headRefOid }
  }
}`;

function repositoryFromResult(result: unknown) {
  return (
    result as {
      data?: {
        repository?: {
          autoMergeAllowed?: boolean;
          viewerPermission?: string;
          pullRequest?: { state?: string; mergeStateStatus?: string; headRefOid?: string };
        };
      };
    } | null
  )?.data?.repository;
}

export function gitHubAutoMergeHasWriteAccess(result: unknown): boolean {
  return ["WRITE", "MAINTAIN", "ADMIN"].includes(
    repositoryFromResult(result)?.viewerPermission ?? "",
  );
}

export function gitHubAutoMergeAvailable(result: unknown, expectedHeadOid?: string): boolean {
  const repository = repositoryFromResult(result);
  return (
    !!repository &&
    gitHubAutoMergeHasWriteAccess(result) &&
    repository.pullRequest?.state === "OPEN" &&
    (!expectedHeadOid || repository.pullRequest.headRefOid === expectedHeadOid) &&
    canQueueGitHubAutoMerge(repository.autoMergeAllowed, repository.pullRequest.mergeStateStatus)
  );
}
