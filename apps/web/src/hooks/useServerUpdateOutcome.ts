import { useEffect } from "react";
import { useProtocolState } from "../protocolState";
import { toastManager } from "../components/ui/toast";
const seen = new Set<string>();
/** A connection opening is not proof that an update succeeded. */
export function useServerUpdateOutcome() {
  const { update } = useProtocolState();
  useEffect(() => {
    if (!update) return;
    const key = `${update.id}:${update.outcome}:${update.version}`;
    if (seen.has(key)) return;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem("f5:seen-server-updates") ?? "[]");
      if (Array.isArray(saved))
        for (const entry of saved.slice(-100)) if (typeof entry === "string") seen.add(entry);
      if (seen.has(key)) return;
    } catch {
      /* In-memory deduplication remains available if storage is blocked. */
    }
    seen.add(key);
    if (seen.size > 100) seen.delete(seen.values().next().value!);
    try {
      localStorage.setItem("f5:seen-server-updates", JSON.stringify([...seen]));
    } catch {
      /* Storage can be disabled. */
    }
    toastManager.add({
      type: update.outcome === "committed" ? "success" : "warning",
      title:
        update.outcome === "committed"
          ? `F5 updated to ${update.version}`
          : `F5 update rolled back to ${update.version}`,
      description: `Update ${update.id}`,
    });
  }, [update]);
}
