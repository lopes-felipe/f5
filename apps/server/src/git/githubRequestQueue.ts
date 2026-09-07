import { Effect } from "effect";

export type GitHubPriority =
  | "interactive"
  | "attention"
  | "changed"
  | "discovery"
  | "cold"
  | "background";
const ranks: Record<GitHubPriority, number> = {
  interactive: 0,
  attention: 1,
  changed: 2,
  discovery: 3,
  background: 3,
  cold: 4,
};
interface Ticket {
  rank: number;
  write: boolean;
  active: boolean;
  released: boolean;
  grant: () => void;
}

/** Host-local admission; background work leaves a read slot for selected PRs. */
export function makeGitHubRequestQueue() {
  const pending: Ticket[] = [];
  let reads = 0;
  let writes = 0;
  let background = 0;
  let backgroundAdmissions = 0;
  const drain = () => {
    pending.sort((a, b) => a.rank - b.rank);
    // One in four background admissions is reserved for waiting cold reconciliation.
    const cold =
      backgroundAdmissions >= 3 ? pending.findIndex((t) => !t.write && t.rank === 4) : -1;
    if (cold >= 0) {
      const [ticket] = pending.splice(cold, 1);
      const firstBackground = pending.findIndex((t) => t.rank > 0);
      pending.splice(firstBackground < 0 ? pending.length : firstBackground, 0, ticket!);
    }
    for (let i = 0; i < pending.length; ) {
      const ticket = pending[i]!;
      if (ticket.write ? writes >= 1 : reads >= 2 || (ticket.rank > 0 && background >= 1)) {
        i++;
        continue;
      }
      pending.splice(i, 1);
      ticket.active = true;
      if (ticket.write) writes++;
      else {
        reads++;
        if (ticket.rank > 0) {
          background++;
          backgroundAdmissions = ticket.rank === 4 ? 0 : backgroundAdmissions + 1;
        }
      }
      ticket.grant();
    }
  };
  return <A, E, R>(priority: GitHubPriority, write: boolean, work: Effect.Effect<A, E, R>) => {
    const acquire = Effect.callback<() => void>((resume) => {
      const ticket: Ticket = {
        rank: write ? 0 : ranks[priority],
        write,
        active: false,
        released: false,
        grant: () => resume(Effect.succeed(release)),
      };
      const release = () => {
        if (ticket.released) return;
        ticket.released = true;
        if (ticket.active) {
          if (ticket.write) writes--;
          else {
            reads--;
            if (ticket.rank > 0) background--;
          }
        } else {
          const index = pending.indexOf(ticket);
          if (index >= 0) pending.splice(index, 1);
        }
        drain();
      };
      pending.push(ticket);
      drain();
      return Effect.sync(release);
    });
    return Effect.acquireUseRelease(
      Effect.interruptible(acquire),
      () => work,
      (release) => Effect.sync(release),
    );
  };
}
