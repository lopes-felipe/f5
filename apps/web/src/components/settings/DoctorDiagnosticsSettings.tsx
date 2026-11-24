import type { DoctorCheck, ServerDoctorReport, ServerHealth } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  RefreshCwIcon,
  XCircleIcon,
} from "lucide-react";

import { serverDoctorReportQueryOptions, serverQueryKeys } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsCard } from "./SettingsCard";

function statusLabel(status: ServerDoctorReport["overallStatus"]): string {
  switch (status) {
    case "ok":
      return "Healthy";
    case "warn":
      return "Warnings";
    case "error":
      return "Issues detected";
  }
}

function StatusIcon({ status }: { readonly status: DoctorCheck["status"] }) {
  switch (status) {
    case "ok":
      return (
        <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
      );
    case "warn":
      return (
        <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      );
    case "error":
      return <XCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />;
  }
}

export function buildClientSupportBundleJson(input: {
  readonly report: ServerDoctorReport;
  readonly serverHealth: ServerHealth | null;
  readonly exportedAt?: string;
}): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      exportedAt: input.exportedAt ?? new Date().toISOString(),
      doctor: input.report,
      serverHealth: input.serverHealth,
    },
    null,
    2,
  )}\n`;
}

function downloadSupportBundle(json: string, dateStamp: string): void {
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `f5-support-bundle-${dateStamp}.json`;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * In-app counterpart to `f5 doctor`. Runs read-only environment, SQLite,
 * provider, and storage checks and exports a redacted JSON support bundle.
 */
export function DoctorDiagnosticsSettings() {
  const queryClient = useQueryClient();
  const report = useQuery(serverDoctorReportQueryOptions());

  const handleExportBundle = () => {
    if (!report.data) return;
    const serverHealth = queryClient.getQueryData<ServerHealth>(serverQueryKeys.health()) ?? null;
    const exportedAt = new Date().toISOString();
    const dateStamp = exportedAt.slice(0, 10);
    const json = buildClientSupportBundleJson({
      report: report.data,
      serverHealth,
      exportedAt,
    });
    downloadSupportBundle(json, dateStamp);
  };

  return (
    <SettingsCard
      title="System health check (Doctor)"
      description="Read-only check of your environment, SQLite database integrity, provider availability, and storage. Support bundles redact user home paths and omit tokens, cookies, and environment values."
      searchTarget="general.doctor"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={!report.data || report.isFetching}
            onClick={handleExportBundle}
          >
            <DownloadIcon className="size-3.5" />
            Export redacted support bundle
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={report.isFetching}
            onClick={() => void report.refetch()}
          >
            <RefreshCwIcon className="size-3.5" />
            Run check
          </Button>
        </div>
      }
    >
      {report.data ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-ui">
            <div className="flex items-center gap-2">
              <StatusIcon status={report.data.overallStatus} />
              <span className="font-medium text-foreground">
                {statusLabel(report.data.overallStatus)}
              </span>
              <span className="text-muted-foreground">
                · {report.data.counts.ok} ok, {report.data.counts.warn} warn,{" "}
                {report.data.counts.error} error
              </span>
            </div>
            <span className="font-mono text-2xs text-muted-foreground">
              v{report.data.runtime.appVersion} · {report.data.runtime.runtimeKind}{" "}
              {report.data.runtime.runtimeVersion} · {report.data.runtime.platform}/
              {report.data.runtime.arch}
            </span>
          </div>

          <ul className="divide-y divide-border rounded-lg border border-border">
            {report.data.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-2.5 px-3 py-2.5">
                <StatusIcon status={check.status} />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-ui font-medium text-foreground">{check.title}</span>
                    <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                      {check.category}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {check.summary}
                  </p>
                  {check.detail ? (
                    <p className="font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">
                      {check.detail}
                    </p>
                  ) : null}
                  {check.hint ? <p className="text-xs text-foreground">{check.hint}</p> : null}
                </div>
              </li>
            ))}
          </ul>

          {report.data.providers.length > 0 ? (
            <div className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Providers</h3>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {report.data.providers.map((provider) => (
                  <div
                    key={provider.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
                  >
                    <span className="truncate font-medium text-foreground">
                      {provider.label}
                      {provider.version ? (
                        <span className="ml-1 font-mono text-2xs font-normal text-muted-foreground">
                          {provider.version}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium capitalize",
                        provider.status === "ready"
                          ? "bg-success/15 text-success"
                          : provider.status === "error"
                            ? "bg-destructive/15 text-destructive"
                            : provider.status === "warning"
                              ? "bg-warning/15 text-warning"
                              : "bg-muted text-muted-foreground",
                      )}
                    >
                      {provider.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-ui text-muted-foreground">
          {report.isError ? "System health check could not be loaded." : "Running health check…"}
        </p>
      )}
    </SettingsCard>
  );
}
