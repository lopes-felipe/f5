// Remote output may contain credentials. Persist only fixed network diagnoses.
export function networkFailureDetail(stderr: string): string {
  if (
    /Authentication failed|could not read (?:Username|Password)|Permission denied \(publickey/i.test(
      stderr,
    )
  ) {
    return "Git could not authenticate with the remote. Check Git credentials or SSH access on the server, then retry.";
  }
  if (
    /Could not resolve host|Failed to connect|Connection timed out|Connection refused|Network is unreachable/i.test(
      stderr,
    )
  ) {
    return "Git could not reach the remote. Check the server's network connection and remote host, then retry.";
  }
  if (/timed out/i.test(stderr))
    return "Git timed out while contacting the remote. Retry when the connection is available.";
  if (/couldn't find remote ref/i.test(stderr))
    return "The requested branch is absent from the remote. Check the selected base branch.";
  if (/non-fast-forward|fetch first|rejected.*behind/i.test(stderr))
    return "The remote branch has newer commits. Fetch and reconcile them before retrying.";
  if (/protected branch|protected branch hook|GH006|GH013/i.test(stderr))
    return "The remote rejected this write under its branch protection rules.";
  if (/Host key verification failed/i.test(stderr))
    return "SSH host verification failed. Configure trusted host keys on the server.";
  if (
    /Repository not found|repository .+ not found|does not appear to be a git repository/i.test(
      stderr,
    )
  ) {
    return "Git could not access the remote repository. Check the remote URL and repository permissions on the server.";
  }
  if (/cannot lock ref|Unable to create .+\.lock/i.test(stderr)) {
    return "Git could not update a local reference. Check for another Git operation or a stale lock, then retry.";
  }
  return "The remote operation failed. Check the remote configuration and repository access on the server, then retry.";
}
