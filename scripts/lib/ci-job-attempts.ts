export interface JobExecution {
  name: string;
  run_attempt: number;
  started_at: string;
  completed_at: string | null;
  conclusion: string | null;
}

/**
 * GitHub clones passed jobs into partial reruns with a new ID/run_attempt but
 * their original timestamps. Resolve the latest snapshot back to its execution.
 */
export function latestJobExecutions<T extends JobExecution>(jobs: readonly T[]): T[] {
  const snapshots = new Map<string, T>();
  for (const job of jobs) {
    const previous = snapshots.get(job.name);
    if (!previous || job.run_attempt > previous.run_attempt) snapshots.set(job.name, job);
  }
  return [...snapshots.values()].map((latest) =>
    jobs
      .filter(
        (job) =>
          job.name === latest.name &&
          job.started_at === latest.started_at &&
          job.completed_at === latest.completed_at &&
          job.conclusion === latest.conclusion,
      )
      .reduce((first, job) => (job.run_attempt < first.run_attempt ? job : first), latest),
  );
}
