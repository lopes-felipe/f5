/** Recognize provider failures inside transport wrappers without exposing the wrappers. */
export function describePrDiffError(error: string, providerName: string) {
  if (/\brate limit\b|\brate[-_]limited\b|\btoo many requests\b/i.test(error)) {
    return {
      title: `${providerName} rate limit reached`,
      description: `${providerName} is temporarily limiting requests, so these changes couldn't be loaded. Try again after the limit resets, or view the changes on ${providerName}.`,
    };
  }
  return {
    title: "Couldn't load the changes",
    description: `The environment couldn't load this pull request's changes. Try again, or view the changes on ${providerName}.`,
  };
}
