import type { TrackedPullRequest } from "@t3tools/contracts";

/** Parse once per listing, before pagination, so qualifiers work identically across forges. */
export function prSearchPredicate(raw: string, viewer: string | null) {
  const text: string[] = [];
  const tests: Array<(pr: TrackedPullRequest) => boolean> = [];
  const normalize = (value: string) => value.toLowerCase();
  for (const [token] of raw.matchAll(/(?:[^\s"]|"[^"]*")+/g)) {
    const match = /^(-?)([a-z][a-z0-9_-]*):(.*)$/i.exec(token);
    const key = match?.[2]?.toLowerCase();
    const value = (match?.[3] ?? "").replaceAll('"', "").trim();
    const negated = match?.[1] === "-";
    if (!value) {
      text.push(token.replaceAll('"', ""));
      continue;
    }
    const add = (test: (pr: TrackedPullRequest) => boolean) =>
      tests.push((pr) => (negated ? !test(pr) : test(pr)));
    if (key === "label") {
      const label = match![3]!;
      const labels = /^"[^"]*"$/.test(label) ? [label.slice(1, -1)] : label.split(",");
      tests.push((pr) => {
        const present = labels.some((name) =>
          pr.labels.some((entry) => normalize(entry) === normalize(name.trim())),
        );
        return negated ? !present : present;
      });
      continue;
    }
    if (key === "author") {
      const author = /^@?me$/i.test(value) ? (viewer ?? value) : value;
      add((pr) => normalize(pr.author ?? "") === normalize(author));
      continue;
    }
    if (key === "draft" && /^(true|false)$/i.test(value)) {
      add((pr) => pr.isDraft === (normalize(value) === "true"));
      continue;
    }
    const reviews: Record<string, TrackedPullRequest["reviewDecision"]> = {
      approved: "approved",
      changes_requested: "changes_requested",
      "changes-requested": "changes_requested",
      required: "review_required",
      "review-required": "review_required",
      none: "none",
    };
    const review = Object.hasOwn(reviews, normalize(value)) ? reviews[normalize(value)] : undefined;
    if (key === "review" && review) {
      add((pr) => pr.reviewDecision === review);
      continue;
    }
    const checks = normalize(value);
    if (
      (key === "status" || key === "checks") &&
      ["success", "passing", "failure", "failing", "pending"].includes(checks)
    ) {
      add((pr) =>
        checks === "passing" || checks === "success"
          ? pr.checkRollup === "success"
          : checks === "pending"
            ? pr.checkRollup === "pending"
            : pr.checkRollup === "failure" || pr.checkRollup === "error",
      );
      continue;
    }
    text.push(token.replaceAll('"', ""));
  }
  const terms = text.map(normalize);
  return (pr: TrackedPullRequest) => {
    const haystack = (
      pr.title +
      " " +
      pr.repository.nameWithOwner +
      " #" +
      pr.number +
      " " +
      (pr.author ?? "")
    ).toLowerCase();
    return tests.every((test) => test(pr)) && terms.every((term) => haystack.includes(term));
  };
}
