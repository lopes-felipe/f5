/** Keep remote URLs, response headers and stack traces out of update UI text. */
export function getUpdateErrorMessage(
  error: unknown,
  action: "check" | "download" | "install",
): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const details = `${code} ${message}`;
  if (/timed out|ETIMEDOUT/i.test(details))
    return action === "install"
      ? "Preparing the update timed out. Try again."
      : "The update request timed out. Try again.";
  if (
    /ENOTFOUND|ENETUNREACH|ECONNREFUSED|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i.test(
      details,
    )
  )
    return "Unable to connect. Check your internet connection and try again.";
  if (/429|rate.?limit/i.test(details)) return "The update service is busy. Try again later.";
  if (/404|CHANNEL_FILE_NOT_FOUND|INVALID_RELEASE_FEED|NO_PUBLISHED_VERSIONS/i.test(details))
    return "Update information is unavailable. Try again later.";
  if (
    message === "F5 did not restart. Try installing the update again." ||
    message === "Could not start the update installer."
  )
    return message;
  return action === "check"
    ? "Could not check for updates. Try again."
    : action === "download"
      ? "Could not download the update. Try again."
      : "Could not install the update. Try again.";
}
