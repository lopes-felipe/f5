import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RuntimeMode } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CompassIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  RefreshCcwIcon,
  SettingsIcon,
  ShieldIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { serverConfigQueryOptions, serverQueryKeys } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { ProviderAccountPanel } from "../settings/ProviderAccountPanel";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import {
  classifyProviderReadiness,
  deriveWizardSteps,
  evaluateRuntimeModeCompatibility,
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
  onSignIn,
}: {
  readonly item: WizardProviderItem;
  readonly onSignIn: (item: WizardProviderItem) => void;
}) {
  const statusBadge =
    item.bucket === "ready"
      ? item.authUnverified
        ? {
            icon: AlertTriangleIcon,
            iconClass: "text-warning-foreground",
            label: "Ready (auth unverified)",
          }
        : item.hasCaveat
          ? {
              icon: AlertTriangleIcon,
              iconClass: "text-warning-foreground",
              label: "Ready with caveats",
            }
          : {
              icon: CheckCircle2Icon,
              iconClass: "text-success-foreground",
              label: "Ready",
            }
      : item.bucket === "checking"
        ? {
            icon: LoaderCircleIcon,
            iconClass: "text-muted-foreground motion-safe:animate-spin",
            label: "Checking…",
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
              label: item.installed ? "Unavailable" : "Not installed",
            };
  const StatusIcon = statusBadge.icon;
  const showMessage =
    item.message && (item.bucket !== "ready" || item.hasCaveat || item.authUnverified);

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
          {showMessage ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.message}</p>
          ) : null}
        </div>
      </div>

      {item.bucket === "needsAuth" ? (
        <Button size="xs" variant="outline" onClick={() => onSignIn(item)}>
          <KeyRoundIcon aria-hidden="true" className="size-3.5" />
          Sign in
        </Button>
      ) : null}
    </li>
  );
}

export function ProviderSetupWizard({
  onDismiss,
}: {
  readonly onDismiss?: () => void;
} = {}) {
  const headingId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const defaultRuntimeMode = useSettings((settings) => settings.defaultRuntimeMode);
  const { updateSettings: updateUnifiedSettings } = useUpdateSettings();
  const hasProjects = useStore((state) => state.projects.length > 0);
  const [locallyHidden, setLocallyHidden] = useState(false);
  const [hasConfirmedRuntimeMode, setHasConfirmedRuntimeMode] = useState(false);
  const [savingRuntimeMode, setSavingRuntimeMode] = useState<RuntimeMode | null>(null);
  const [signInProvider, setSignInProvider] = useState<WizardProviderItem | null>(null);

  const serverConfigQuery = useQuery(serverConfigQueryOptions());

  const providers = useMemo(
    () => serverConfigQuery.data?.providers ?? [],
    [serverConfigQuery.data?.providers],
  );
  const readiness = useMemo(() => classifyProviderReadiness(providers), [providers]);

  const orderedProviders = useMemo(
    () => [
      ...readiness.ready,
      ...readiness.checking,
      ...readiness.needsAuth,
      ...readiness.needsAttention,
    ],
    [readiness.checking, readiness.needsAttention, readiness.needsAuth, readiness.ready],
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
      const existing = queryClient.getQueryData(serverQueryKeys.config());
      if (existing) {
        queryClient.setQueryData(serverQueryKeys.config(), {
          ...existing,
          providers: nextProviders,
        });
      } else {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
      }
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

  const handleSelectRuntimeMode = useCallback(
    async (mode: RuntimeMode) => {
      if (mode === defaultRuntimeMode) {
        setHasConfirmedRuntimeMode(true);
        return;
      }
      setSavingRuntimeMode(mode);
      try {
        await updateUnifiedSettings({ defaultRuntimeMode: mode });
        setHasConfirmedRuntimeMode(true);
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

  const handleHideWizard = useCallback(() => {
    if (onDismiss) {
      onDismiss();
    } else {
      setLocallyHidden(true);
    }
  }, [onDismiss]);

  const handleOpenProviderSettings = useCallback(() => {
    void navigate({ to: "/settings", search: { category: "providers" } });
  }, [navigate]);

  if (locallyHidden) {
    return null;
  }

  const summaryParts = [
    `${readiness.ready.length} ready`,
    ...(readiness.checking.length > 0 ? [`${readiness.checking.length} checking`] : []),
    `${readiness.needsAuth.length} need sign-in`,
    `${readiness.needsAttention.length} unavailable`,
    ...(readiness.disabledCount > 0 ? [`${readiness.disabledCount} disabled`] : []),
  ];

  const summaryText =
    serverConfigQuery.isError && !serverConfigQuery.data
      ? "Could not load provider status."
      : readiness.enabledCount === 0
        ? serverConfigQuery.isLoading
          ? "Detecting installed providers…"
          : readiness.disabledCount > 0
            ? `No enabled providers (${readiness.disabledCount} disabled).`
            : "No providers detected yet."
        : summaryParts.join(", ");

  return (
    <>
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
                Review detected coding providers and pick your profile-wide default permission mode
                for new threads.
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={handleHideWizard}>
              Hide quick setup
            </Button>
            <Button size="sm" variant="outline" onClick={handleOpenProviderSettings}>
              <SettingsIcon aria-hidden="true" className="size-3.5" />
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
              aria-busy={refreshProvidersMutation.isPending}
              disabled={refreshProvidersMutation.isPending}
              onClick={() => refreshProvidersMutation.mutate()}
            >
              {refreshProvidersMutation.isPending ? (
                <LoaderCircleIcon
                  aria-hidden="true"
                  className="size-3.5 motion-safe:animate-spin"
                />
              ) : (
                <RefreshCcwIcon aria-hidden="true" className="size-3.5" />
              )}
              {refreshProvidersMutation.isPending ? "Refreshing providers..." : "Refresh providers"}
            </Button>
          </div>

          {serverConfigQuery.isError && !serverConfigQuery.data ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs text-foreground"
            >
              <span>
                Could not load server provider status. Check your connection and try again.
              </span>
              <Button size="xs" variant="outline" onClick={() => void serverConfigQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : orderedProviders.length > 0 ? (
            <ul aria-label="Detected providers" className="space-y-2">
              {orderedProviders.map((item) => (
                <ProviderStatusRow key={item.instanceId} item={item} onSignIn={setSignInProvider} />
              ))}
            </ul>
          ) : !serverConfigQuery.isLoading ? (
            <p className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
              Install a supported CLI such as Claude Code or Codex, or open provider settings to add
              a custom ACP agent.
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
            Sets the profile-wide default for new threads. Each provider decides when it asks for
            approval, and you can override this per thread or per project.
          </p>

          <div
            role="group"
            aria-label="Default permissions for new threads"
            className="mt-3 grid gap-2.5 sm:grid-cols-2"
          >
            {RUNTIME_MODE_WIZARD_OPTIONS.map((option) => {
              const selected = defaultRuntimeMode === option.value;
              const isSaving = savingRuntimeMode === option.value;
              const compatibility = evaluateRuntimeModeCompatibility(option.value, readiness.ready);
              const isUnsupported = compatibility.status === "unsupported";
              const unsupportedNames = compatibility.unsupportedProviders
                .map((entry) => entry.displayName)
                .join(", ");

              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  disabled={savingRuntimeMode !== null || isUnsupported}
                  onClick={() => void handleSelectRuntimeMode(option.value)}
                  className={cn(
                    "relative flex flex-col gap-1 rounded-xl border border-border bg-background/50 p-3.5 text-left transition-colors duration-(--duration-fast)",
                    !isUnsupported ? "hover:bg-accent/60" : "cursor-not-allowed opacity-65",
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
                      {isUnsupported ? "Not supported" : option.badge}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{option.summary}</p>
                  {compatibility.status === "unsupported" ? (
                    <p className="mt-1 text-2xs text-warning-foreground">
                      Not supported by ready providers ({unsupportedNames}). Pick a mode your ready
                      provider supports.
                    </p>
                  ) : compatibility.status === "partial" ? (
                    <p className="mt-1 text-2xs text-muted-foreground">
                      Not supported by {unsupportedNames}.
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <Dialog
        open={signInProvider !== null}
        onOpenChange={(open) => {
          if (!open) setSignInProvider(null);
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sign in to {signInProvider?.displayName ?? "provider"}</DialogTitle>
            <DialogDescription>
              Complete authentication using this instance&apos;s configured executable and
              environment. Provider status refreshes automatically when sign-in succeeds.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {signInProvider ? (
              <ProviderAccountPanel
                instanceId={signInProvider.instanceId}
                driver={signInProvider.driver}
                authType={signInProvider.authType}
                status="unauthenticated"
                autoStart
                cancelOnUnmount
                onLoginFinished={(succeeded) => {
                  if (succeeded) {
                    setSignInProvider(null);
                    refreshProvidersMutation.mutate();
                  }
                }}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
