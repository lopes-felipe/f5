import type { ProviderInstanceId, ProviderKind, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { create } from "zustand";

interface ActiveComposerSelection {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId | null;
  readonly provider: ProviderKind;
  readonly model: string;
}

/** The resolved picker selection, shared without reimplementing the composer's fallback rules. */
export const useActiveComposerSelection = create<{
  registrations: ReadonlyMap<symbol, ActiveComposerSelection>;
}>(() => ({ registrations: new Map() }));

export function usePublishComposerSelection(
  threadId: ThreadId,
  instanceId: ProviderInstanceId | null,
  provider: ProviderKind,
  model: string,
) {
  useLayoutEffect(() => {
    const registration = Symbol();
    const selection = { threadId, instanceId, provider, model };
    useActiveComposerSelection.setState((state) => ({
      registrations: new Map(state.registrations).set(registration, selection),
    }));
    return () => {
      useActiveComposerSelection.setState((state) => {
        const registrations = new Map(state.registrations);
        registrations.delete(registration);
        return { registrations };
      });
    };
  }, [threadId, instanceId, provider, model]);
}
