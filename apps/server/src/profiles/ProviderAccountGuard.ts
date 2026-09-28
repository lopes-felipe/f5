import { Effect } from "effect";
import { ProviderValidationError } from "../provider/Errors.ts";

// Shared by the account UI and every provider dispatch path in this profile server.
// Admission is synchronous: an account change cannot pass a session/turn in flight.
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

export function acquireAccountAdmission(stateDir: string, instanceId: string): () => void {
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

export function withAccountAdmission(stateDir: string, instanceId: string, operation: string) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => acquireAccountAdmission(stateDir, instanceId),
        catch: (cause) => new ProviderValidationError({ operation, issue: String(cause) }),
      }),
      () => effect,
      (release) => Effect.sync(release),
    );
}
