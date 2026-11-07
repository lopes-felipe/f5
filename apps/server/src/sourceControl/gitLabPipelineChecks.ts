import type { PrHubCheck } from "@t3tools/contracts";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function pipelineStatus(value: unknown): PrHubCheck["status"] {
  switch (text(value)?.toLowerCase()) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "canceled":
    case "cancelling":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "manual":
      return "neutral";
    default:
      return "pending";
  }
}

export function gitLabHeadPipelineChecks(value: unknown): ReadonlyArray<PrHubCheck> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const pipeline = record(value);
  return [
    {
      name: "Pipeline",
      status: pipelineStatus(pipeline.status),
      description: null,
      url: text(pipeline.web_url),
    },
  ];
}

/** A full page may omit a failed child; accept only complete, bounded reads. */
export function gitLabTriggerJobChecks(value: unknown): ReadonlyArray<PrHubCheck> {
  if (!Array.isArray(value) || value.length >= 100) return [];
  return value.flatMap((entry): PrHubCheck[] => {
    const job = record(entry);
    const name = text(job.name);
    if (
      !name ||
      !job.downstream_pipeline ||
      typeof job.downstream_pipeline !== "object" ||
      Array.isArray(job.downstream_pipeline)
    )
      return [];
    const pipeline = record(job.downstream_pipeline);
    const status = pipelineStatus(pipeline.status);
    return [
      {
        name,
        status: status === "failure" && job.allow_failure === true ? "neutral" : status,
        description: "Downstream pipeline",
        url: text(pipeline.web_url),
      },
    ];
  });
}
