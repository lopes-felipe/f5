import { useRecoveryStateStore } from "../recoveryStateStore";
import { useStore } from "../store";

/**
 * True once the orchestration startup snapshot has merged and the WS recovery
 * handshake has completed. While false, "no data" is ambiguous.
 */
export function isStartupReady(snapshot: {
  threadsHydrated: boolean;
  recoveryEpoch: number;
}): boolean {
  return snapshot.threadsHydrated && snapshot.recoveryEpoch > 0;
}

export function useStartupReady(): boolean {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const recoveryEpoch = useRecoveryStateStore((store) => store.recoveryEpoch);
  return isStartupReady({ threadsHydrated, recoveryEpoch });
}
