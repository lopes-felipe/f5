import { Effect } from "effect";
import { ProviderValidationError } from "../provider/Errors.ts";

// Shared by account changes, installation updates and every provider dispatch path in this server.
// Admission is synchronous: an account change cannot pass a session/turn in flight.
const updates = new Map<string, { installKey: string; instanceIds: readonly string[] }>();

/** Claim every instance sharing an install before stopping sessions; release after verification. */
export function beginProviderUpdate(
  stateDir: string,
  installKey: string,
  instanceIds: readonly string[],
): () => void {
  if (updates.has(stateDir)) throw new Error("Another provider update is already running.");
  for (const instanceId of instanceIds) {
    const current = states.get(JSON.stringify([stateDir, instanceId]));
    if (current?.changing || current?.admissions)
      throw new Error(
        "This provider is starting work or changing its account. Finish or stop it before updating.",
      );
  }
  const update = { installKey, instanceIds };
  updates.set(stateDir, update);
  return () => {
    if (updates.get(stateDir) === update) updates.delete(stateDir);
  };
}

export function hasProviderUpdate(stateDir: string): boolean {
  return updates.has(stateDir);
}

function assertNotUpdating(stateDir: string, instanceId: string, installKey?: string): void {
  const update = updates.get(stateDir);
  if (
    update &&
    (update.instanceIds.includes(instanceId) ||
      (installKey !== undefined && update.installKey === installKey))
  )
    throw new Error(
      "Provider update in progress. Wait until installation and verification finish before starting work.",
    );
}

const states = new Map<string, { changing: boolean; admissions: number }>();
function stateFor(stateDir: string, instanceId: string) {
  const key = JSON.stringify([stateDir, instanceId]);
  let state = states.get(key);
  if (!state) {
    state = { changing: false, admissions: 0 };
    states.set(key, state);
  }
  return {
    state,
    clean: () => {
      if (!state.changing && state.admissions === 0) states.delete(key);
    },
  };
}

export function beginAccountChange(stateDir: string, instanceId: string): () => void {
  assertNotUpdating(stateDir, instanceId);
  const { state, clean } = stateFor(stateDir, instanceId);
  if (state.changing || state.admissions) {
    throw new Error(
      "This provider instance is starting work or changing its account. Try again when it finishes.",
    );
  }
  state.changing = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.changing = false;
    clean();
  };
}

export function acquireAccountAdmission(
  stateDir: string,
  instanceId: string,
  installKey?: string,
): () => void {
  assertNotUpdating(stateDir, instanceId, installKey);
  const { state, clean } = stateFor(stateDir, instanceId);
  if (state.changing)
    throw new Error(
      "Account change in progress. Wait before starting a session or sending a turn.",
    );
  state.admissions++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.admissions--;
    clean();
  };
}

export function withAccountAdmission(
  stateDir: string,
  instanceId: string,
  operation: string,
  installKey?: string,
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => acquireAccountAdmission(stateDir, instanceId, installKey),
        catch: (cause) => new ProviderValidationError({ operation, issue: String(cause) }),
      }),
      () => effect,
      (release) => Effect.sync(release),
    );
}
