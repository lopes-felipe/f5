import type { AgentSessionScanResult } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ensureNativeApi } from "../../nativeApi";
import { readAppSettingsSnapshot, updateAppSettings } from "../../appSettings";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";

export function ProjectHistoryImportPanel() {
  const [scan, setScan] = useState<AgentSessionScanResult | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [includeHistory, setIncludeHistory] = useState(false);
  const [busy, setBusy] = useState<"scan" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const discover = async () => {
    setBusy("scan");
    setError(null);
    try {
      setScan(await ensureNativeApi().projects.scanAgentSessions());
      setSelected(new Set());
    } catch {
      setError(
        "Could not discover agent projects. Check the agent homes in Providers settings, then try again.",
      );
    } finally {
      setBusy(null);
    }
  };
  const importSelected = async () => {
    if (!scan) return;
    const candidates = scan.candidates.filter((candidate) => selected.has(candidate.id));
    const previousStatus = readAppSettingsSnapshot().onboardingLiteStatus;
    // Importing the first thread normally finishes onboarding. Hold this screen
    // until the whole explicit selection is imported, including after a retry.
    updateAppSettings({ onboardingLiteStatus: "reopened" });
    setBusy("import");
    setError(null);
    let ready = 0;
    let skipped = 0;
    let truncated = false;
    try {
      for (const candidate of candidates) {
        const result = await ensureNativeApi().projects.importAgentSessions({
          candidateId: candidate.id,
          expectedWorkspaceRoot: candidate.path,
          includeHistory,
        });
        ready += result.threadIds.length;
        skipped += result.skippedCount;
        truncated ||= result.truncated;
        setSelected((current) => new Set([...current].filter((id) => id !== candidate.id)));
      }
      toastManager.add({
        type: "info",
        title: candidates.length + " projects ready",
        description: includeHistory
          ? ready +
            " threads available; " +
            skipped +
            " skipped." +
            (truncated ? " Import limits were reached; some history was not imported." : "")
          : "Your agent settings and credentials have not changed.",
      });
      if (previousStatus !== "reopened")
        updateAppSettings({ onboardingLiteStatus: previousStatus });
      setScan((current) =>
        current
          ? {
              ...current,
              candidates: current.candidates.map((candidate) =>
                candidates.some((imported) => imported.id === candidate.id)
                  ? { ...candidate, alreadyImported: true }
                  : candidate,
              ),
            }
          : null,
      );
    } catch {
      setError(
        "Some projects could not be imported. Completed imports are preserved. Scan again to retry.",
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      aria-label="Agent setup and project import"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Set up agents and bring your projects</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Use the agent homes configured on this server. Scanning is read-only and starts only
            when you ask.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/settings" search={{ category: "providers" }} />}
        >
          Set up agents
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Codex and Claude history can be imported without copying credentials or enabling additional
        agents. Other agents remain available in Providers settings.
      </p>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void discover()}>
        {busy === "scan" ? "Scanning…" : "Discover projects from agent history"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {scan ? (
        <>
          {scan.truncated ? (
            <p className="text-xs text-muted-foreground">
              Discovery reached its scan limit. Some older projects may be missing.
            </p>
          ) : null}
          {scan.candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No projects found in the configured Codex and Claude homes.
            </p>
          ) : (
            <ul className="max-h-64 space-y-2 overflow-auto">
              {scan.candidates.map((candidate) => (
                <li key={candidate.id}>
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <Checkbox
                      checked={selected.has(candidate.id)}
                      disabled={busy !== null}
                      onCheckedChange={(checked) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (checked) next.add(candidate.id);
                          else next.delete(candidate.id);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {candidate.title}
                        {candidate.alreadyImported ? " · already added" : ""}
                      </span>
                      <span className="block break-all text-muted-foreground">
                        {candidate.path}
                      </span>
                      <span className="text-muted-foreground">
                        {candidate.sources
                          .map((source) => (source === "codex" ? "Codex" : "Claude"))
                          .join(", ")}{" "}
                        · {candidate.threadCount} recent threads
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={includeHistory}
              disabled={busy !== null}
              onCheckedChange={(checked) => setIncludeHistory(Boolean(checked))}
            />
            Also import recent thread history
          </label>
          <p className="text-xs text-muted-foreground">
            History import retains the first prompt and up to 199 recent messages per thread from
            the last 30 days. Continuing a thread resumes its original CLI session with F5’s current
            approval settings.
          </p>
          <Button
            size="sm"
            disabled={selected.size === 0 || busy !== null}
            onClick={() => void importSelected()}
          >
            {busy === "import" ? "Importing…" : "Import selected projects"}
          </Button>
        </>
      ) : null}
    </section>
  );
}
