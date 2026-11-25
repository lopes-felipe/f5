import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RuntimeMode } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CompassIcon,
  CopyIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  RefreshCcwIcon,
  SettingsIcon,
  ShieldIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import { useAppSettings } from "../../appSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { serverConfigQueryOptions, serverQueryKeys } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  classifyProviderReadiness,
  deriveWizardSteps,
  RUNTIME_MODE_WIZARD_OPTIONS,
  type WizardProviderItem,
  type WizardStepState,
} from "./providerSetupWizard.logic";

function stepPillClass(state: WizardStepState): string {
  switch (state) {
    case "complete":
      return "border-success/30 bg-success/10 text-success-foreground";
    case "current":
      return "border-primary/40 bg-primary/10 text-foreground";
    case "upcoming":
      return "border-border/70 bg-muted/40 text-muted-foreground";
  }
}

function ProviderStatusRow({
  item,
  copied,
  onCopyLogin,
}: {
  readonly item: WizardProviderItem;
  readonly copied: boolean;
  readonly onCopyLogin: (command: string, instanceId: string) => void;
}) {
  const statusBadge =
    item.bucket === "ready"
      ? {
          icon: CheckCircle2Icon,
          iconClass: "text-success-foreground",
          label: "Ready",
        }
      : item.bucket === "needsAuth"
        ? {
            icon: KeyRoundIcon,
            iconClass: "text-warning-foreground",
            label: "Sign-in required",
          }
        : {
            icon: item.installed ? AlertTriangleIcon : XCircleIcon,
            iconClass: item.installed ? "text-warning-foreground" : "text-muted-foreground",
            label: item.installed ? "Needs attention" : "Not installed",
          };
  const StatusIcon = statusBadge.icon;

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-background/50 px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <StatusIcon aria-hidden="true" className={cn("size-4 shrink-0", statusBadge.iconClass)} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{item.displayName}</span>
            {item.version ? (
              <span className="rounded-full border border-border/70 bg-muted/50 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                {item.version}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground">{statusBadge.label}</span>
          </div>
          {item.bucket !== "ready" && item.message ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.message}</p>
          ) : null}
        </div>
      </div>

      {item.bucket === "needsAuth" && item.loginCommand ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => onCopyLogin(item.loginCommand!, item.instanceId)}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          <span className="font-mono">{item.loginCommand}</span>
        </Button>
      ) : null}
    </li>
  );
}

export function ProviderSetupWizard() {
  const headingId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { updateSettings: updateAppSettings } = useAppSettings();
  const defaultRuntimeMode = useSettings((settings) => settings.defaultRuntimeMode);
  const { updateSettings: updateUnifiedSettings } = useUpdateSettings();
  const hasProjects = useStore((state) => state.projects.length > 0);
  const [hasConfirmedRuntimeMode, setHasConfirmedRuntimeMode] = useState(false);
  const [savingRuntimeMode, setSavingRuntimeMode] = useState<RuntimeMode | null>(null);
  const [copiedInstanceId, setCopiedInstanceId] = useState<string | null>(null);
  const { isCopied, copyToClipboard } = useCopyToClipboard<string>();

  const serverConfigQuery = useQuery({
    ...serverConfigQueryOptions(),
    retry: false,
  });

  const providers = useMemo(
    () => serverConfigQuery.data?.providers ?? [],
    [serverConfigQuery.data?.providers],
  );
  const readiness = useMemo(() => classifyProviderReadiness(providers), [providers]);

  const orderedProviders = useMemo(
    () => [...readiness.ready, ...readiness.needsAuth, ...readiness.needsAttention],
    [readiness.needsAttention, readiness.needsAuth, readiness.ready],
  );

  const steps = useMemo(
    () =>
      deriveWizardSteps({
        hasAnyReadyProvider: readiness.hasAnyReady,
        hasConfirmedRuntimeMode,
        hasProjects,
      }),
    [hasConfirmedRuntimeMode, hasProjects, readiness.hasAnyReady],
  );

  const refreshProvidersMutation = useMutation({
    mutationFn: async () => {
      const result = await ensureNativeApi().server.refreshProviders({});
      return result.providers;
    },
    onSuccess: (nextProviders) => {
      queryClient.setQueryData(serverQueryKeys.config(), (existing) =>
        existing ? { ...existing, providers: nextProviders } : existing,
      );
      toastManager.add({
        type: "success",
        title: "Providers refreshed",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not refresh providers",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const handleCopyLogin = useCallback(
    (command: string, instanceId: string) => {
      setCopiedInstanceId(instanceId);
      copyToClipboard(command, instanceId);
      toastManager.add({
        type: "info",
        title: "Copied sign-in command",
        description: `Run "${command}" in your terminal, then refresh providers.`,
      });
    },
    [copyToClipboard],
  );

  const handleSelectRuntimeMode = useCallback(
    async (mode: RuntimeMode) => {
      setHasConfirmedRuntimeMode(true);
      if (mode === defaultRuntimeMode) {
        return;
      }
      setSavingRuntimeMode(mode);
      try {
        await updateUnifiedSettings({ defaultRuntimeMode: mode });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not save default permissions",
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setSavingRuntimeMode(null);
      }
    },
    [defaultRuntimeMode, updateUnifiedSettings],
  );

  const handleSkipSetup = useCallback(() => {
    updateAppSettings({ onboardingLiteStatus: "dismissed" });
  }, [updateAppSettings]);

  const handleOpenProviderSettings = useCallback(() => {
    void navigate({ to: "/settings", search: { category: "providers" } });
  }, [navigate]);

  const summaryText =
    readiness.enabledCount === 0
      ? serverConfigQuery.isLoading
        ? "Detecting installed providers…"
        : "No providers detected yet."
      : `${readiness.ready.length} ready, ${readiness.needsAuth.length} need sign-in, ${readiness.needsAttention.length} unavailable`;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="provider-setup-wizard"
      className="rounded-2xl border border-border/80 bg-card p-5 shadow-xs"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <div
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <CompassIcon className="size-4" />
          </div>
          <div className="space-y-1">
            <h2 id={headingId} className="text-base font-medium text-foreground">
              Quick setup
            </h2>
            <p className="text-sm text-muted-foreground">
              Review detected coding providers and pick your default permission mode for new
              threads.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={handleSkipSetup}>
            Skip setup
          </Button>
          <Button size="sm" variant="outline" onClick={handleOpenProviderSettings}>
            <SettingsIcon className="size-3.5" />
            Configure providers
          </Button>
        </div>
      </div>

      {/* Step progress indicator */}
      <ol
        aria-label="Setup steps"
        className="mt-4 flex flex-wrap items-center gap-2 border-y border-border/60 py-3"
      >
        {steps.map((step) => (
          <li
            key={step.id}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              stepPillClass(step.state),
            )}
          >
            {step.state === "complete" ? (
              <CheckCircle2Icon aria-hidden="true" className="size-3.5" />
            ) : (
              <span className="font-mono text-2xs">{step.number}</span>
            )}
            <span>{step.label}</span>
          </li>
        ))}
      </ol>

      {/* Step 1: Detected providers */}
      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-foreground">1. Detected providers</h3>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {summaryText}
            </p>
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={refreshProvidersMutation.isPending}
            onClick={() => refreshProvidersMutation.mutate()}
          >
            {refreshProvidersMutation.isPending ? (
              <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" />
            ) : (
              <RefreshCcwIcon className="size-3.5" />
            )}
            Refresh providers
          </Button>
        </div>

        {orderedProviders.length > 0 ? (
          <ul aria-label="Detected providers" className="space-y-2">
            {orderedProviders.map((item) => (
              <ProviderStatusRow
                key={item.instanceId}
                item={item}
                copied={isCopied && copiedInstanceId === item.instanceId}
                onCopyLogin={handleCopyLogin}
              />
            ))}
          </ul>
        ) : !serverConfigQuery.isLoading ? (
          <p className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
            Install a supported CLI such as Claude Code or Codex, or open provider settings to add a
            custom ACP agent.
          </p>
        ) : null}
      </div>

      {/* Step 2: Default permission mode */}
      <div className="mt-6 border-t border-border/60 pt-5">
        <div className="flex items-center gap-2">
          <ShieldIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">
            2. Default permissions for new threads
          </h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose what agents can do without asking first. You can override this per thread or per
          project at any time.
        </p>

        <div
          role="group"
          aria-label="Default permissions for new threads"
          className="mt-3 grid gap-2.5 sm:grid-cols-2"
        >
          {RUNTIME_MODE_WIZARD_OPTIONS.map((option) => {
            const selected = defaultRuntimeMode === option.value;
            const isSaving = savingRuntimeMode === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                disabled={savingRuntimeMode !== null}
                onClick={() => void handleSelectRuntimeMode(option.value)}
                className={cn(
                  "relative flex flex-col gap-1 rounded-xl border border-border bg-background/50 p-3.5 text-left transition-colors duration-(--duration-fast)",
                  "hover:bg-accent/60",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  selected ? "border-primary bg-accent/40 ring-1 ring-primary" : null,
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{option.label}</span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
                    {isSaving ? (
                      <LoaderCircleIcon
                        aria-hidden="true"
                        className="size-3 motion-safe:animate-spin"
                      />
                    ) : selected ? (
                      <CheckCircle2Icon aria-hidden="true" className="size-3 text-primary" />
                    ) : null}
                    {option.badge}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{option.summary}</p>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
