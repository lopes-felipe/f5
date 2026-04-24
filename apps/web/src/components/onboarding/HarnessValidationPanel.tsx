import { useMutation } from "@tanstack/react-query";
import {
  type ProviderStartOptions,
  type ServerHarnessValidationResult,
  type ServerProviderAuthStatus,
} from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  HeartPulseIcon,
  LoaderCircleIcon,
  PlayCircleIcon,
  RefreshCcwIcon,
} from "lucide-react";
import { memo, useCallback, useId, useMemo, useState } from "react";

import type { AppSettings } from "../../appSettings";
import { useAppSettings } from "../../appSettings";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { validateHarnessesMutationOptions } from "../../lib/serverReactQuery";
import { cn } from "../../lib/utils";
import { ensureNativeApi } from "../../nativeApi";
import { ClaudeAI, type Icon, OpenAI } from "../Icons";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { HARNESSES, type HarnessBrandAccent, type HarnessMeta } from "./harnessMeta";
import { presentProviderStatus } from "./providerStatusIcon";

interface HarnessRowPresentation {
  readonly kind:
    | "idle"
    | "checking"
    | "notInstalled"
    | "upgradeRequired"
    | "authRequired"
    | "probeFailure"
    | "connectivityFailure"
    | "ready";
  readonly body: string;
  readonly message?: string;
  readonly docsLabel?: string;
}

type SegmentTone = "ready" | "warning" | "error" | "idle";

interface BrandAccentStyles {
  readonly tile: string;
  readonly icon: Icon;
  readonly iconClass: string;
}

// Static class strings so Tailwind's JIT picks them up.
const BRAND_ACCENTS: Record<HarnessBrandAccent, BrandAccentStyles> = {
  claude: {
    tile: "bg-[#D97757]/12 border border-[#D97757]/20 dark:bg-[#D97757]/15",
    icon: ClaudeAI,
    iconClass: "size-6",
  },
  openai: {
    tile: "bg-foreground/[0.08] border border-foreground/10",
    icon: OpenAI,
    iconClass: "size-6 text-foreground",
  },
};

function supportedModelNames(meta: HarnessMeta): ReadonlyArray<string> {
  return meta.supportedModels.map((model) => model.name);
}

function buildOnboardingProviderOptions(
  settings: Pick<AppSettings, "codexBinaryPath" | "codexHomePath">,
): ProviderStartOptions | undefined {
  if (!settings.codexBinaryPath && !settings.codexHomePath) {
    return undefined;
  }

  return {
    codex: {
      ...(settings.codexBinaryPath ? { binaryPath: settings.codexBinaryPath } : {}),
      ...(settings.codexHomePath ? { homePath: settings.codexHomePath } : {}),
    },
  };
}

function authPillLabel(authStatus: ServerProviderAuthStatus): string {
  if (authStatus === "authenticated") {
    return "Authenticated";
  }
  if (authStatus === "unauthenticated") {
    return "Authentication required";
  }
  return "Auth unverified";
}

function presentHarnessRow(result: ServerHarnessValidationResult | null): HarnessRowPresentation {
  if (!result) {
    return {
      kind: "idle",
      body: "Not checked yet.",
    };
  }

  if (result.status === "ready") {
    return {
      kind: "ready",
      body: "Ready",
      ...(result.message ? { message: result.message } : {}),
    };
  }

  switch (result.failureKind) {
    case "notInstalled":
      return {
        kind: "notInstalled",
        body: "Not installed.",
        ...(result.message ? { message: result.message } : {}),
        docsLabel: "Install guide",
      };
    case "unsupportedVersion":
      return {
        kind: "upgradeRequired",
        body: result.message ?? "Unsupported CLI version.",
        docsLabel: "Upgrade docs",
      };
    case "unauthenticated":
      return {
        kind: "authRequired",
        body: result.message ?? "Authentication is required.",
        docsLabel: "Open docs",
      };
    case "connectivity":
      return {
        kind: "connectivityFailure",
        body: result.message ?? "Connectivity check failed.",
      };
    case "versionProbeFailed":
    case "versionProbeTimeout":
    case "preflight":
    default:
      return {
        kind: "probeFailure",
        body: result.message ?? "Validation failed.",
        docsLabel: "Open docs",
      };
  }
}

function segmentToneFor(result: ServerHarnessValidationResult | null | undefined): SegmentTone {
  if (!result) {
    return "idle";
  }
  if (result.status === "ready") {
    return "ready";
  }
  if (result.failureKind === "unauthenticated") {
    return "warning";
  }
  return "error";
}

const SEGMENT_TONE_CLASSES: Record<SegmentTone, string> = {
  ready: "bg-emerald-500/80",
  warning: "bg-amber-500/80",
  error: "bg-destructive/80",
  idle: "bg-muted-foreground/20",
};

const HarnessRow = memo(function HarnessRow({
  meta,
  result,
  isPending,
  onOpenDocs,
  animationDelayMs,
}: {
  readonly meta: HarnessMeta;
  readonly result: ServerHarnessValidationResult | null;
  readonly isPending: boolean;
  readonly onOpenDocs: (meta: HarnessMeta) => void;
  readonly animationDelayMs: number;
}) {
  const presentation = presentHarnessRow(result);
  const providerPresentation =
    presentation.kind === "ready"
      ? presentProviderStatus({ status: "ready" })
      : presentation.kind === "idle" || presentation.kind === "checking"
        ? null
        : presentProviderStatus({ status: "error" });
  const StatusIcon = providerPresentation?.icon;
  const brand = BRAND_ACCENTS[meta.brandAccent];
  const BrandIcon = brand.icon;
  const modelNames = supportedModelNames(meta);

  return (
    <li
      className={cn(
        "rounded-2xl border border-border/70 bg-background/40 p-4 transition-colors",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500",
        "hover:border-foreground/25",
        presentation.kind === "ready" && "border-emerald-500/25 shadow-sm shadow-emerald-500/10",
      )}
      style={{ animationDelay: `${animationDelayMs}ms` }}
    >
      <div className="flex gap-3">
        <div
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl",
            brand.tile,
          )}
          aria-hidden="true"
        >
          <BrandIcon className={brand.iconClass} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{meta.displayName}</h3>
            <span className="rounded-full border border-border/80 bg-background/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {meta.cliLabel}
            </span>
            {presentation.kind === "ready" && result?.version ? (
              <span className="rounded-full border border-emerald-500/25 bg-emerald-500/8 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                {result.version}
              </span>
            ) : null}
            {presentation.kind === "ready" && result ? (
              <span className="rounded-full border border-border/80 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                {authPillLabel(result.authStatus)}
              </span>
            ) : null}
          </div>

          <div className="mt-1 flex items-center gap-2">
            <span className="flex size-4 items-center justify-center" aria-hidden="true">
              {isPending ? (
                <LoaderCircleIcon
                  className="size-4 animate-spin text-primary"
                  aria-label="Checking"
                  role="img"
                />
              ) : presentation.kind === "idle" ? (
                <span className="size-3 rounded-full border border-dashed border-muted-foreground/50" />
              ) : StatusIcon ? (
                <StatusIcon
                  className={cn(
                    "size-4",
                    providerPresentation?.variant === "ready"
                      ? "text-emerald-500"
                      : providerPresentation?.variant === "warning"
                        ? "text-amber-500"
                        : "text-destructive",
                  )}
                  aria-label={providerPresentation.ariaLabel}
                  role="img"
                />
              ) : null}
            </span>
            <p className="text-sm text-muted-foreground">
              {isPending ? "Running connectivity check…" : presentation.body}
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
              Covers
            </span>
            {modelNames.map((name) => (
              <span
                key={name}
                className="rounded-full border border-border/80 bg-background/70 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {name}
              </span>
            ))}
          </div>

          {!isPending && presentation.message ? (
            <p className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap">
              {presentation.message}
            </p>
          ) : null}
        </div>

        {!isPending && presentation.docsLabel ? (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 self-start"
            onClick={() => onOpenDocs(meta)}
          >
            {presentation.docsLabel}
            <ArrowUpRightIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  );
});

interface SummaryPresentation {
  readonly kind: "idle" | "pending" | "resolved";
  readonly label: string;
  readonly segments: ReadonlyArray<SegmentTone>;
}

function buildSummary({
  isPending,
  hasResults,
  results,
  totalCount,
}: {
  readonly isPending: boolean;
  readonly hasResults: boolean;
  readonly results: ReadonlyArray<ServerHarnessValidationResult | null>;
  readonly totalCount: number;
}): SummaryPresentation {
  if (isPending) {
    return {
      kind: "pending",
      label: `Checking ${totalCount} ${totalCount === 1 ? "harness" : "harnesses"}…`,
      segments: results.map(() => "idle"),
    };
  }

  if (!hasResults) {
    return {
      kind: "idle",
      label: "Not run yet",
      segments: results.map(() => "idle"),
    };
  }

  const tones = results.map(segmentToneFor);
  const readyCount = tones.filter((tone) => tone === "ready").length;
  const attentionCount = tones.filter(
    (tone) => tone === "warning" || tone === "error",
  ).length;

  const label =
    readyCount === totalCount
      ? `${readyCount} of ${totalCount} ready`
      : attentionCount > 0
        ? `${attentionCount} of ${totalCount} need${attentionCount === 1 ? "s" : ""} attention`
        : `${readyCount} of ${totalCount} ready`;

  return {
    kind: "resolved",
    label,
    segments: tones,
  };
}

export function HarnessValidationPanel() {
  const headingId = useId();
  const { settings } = useAppSettings();
  const [hasTriggered, setHasTriggered] = useState(false);
  const [lastResolvedResults, setLastResolvedResults] =
    useState<ReadonlyArray<ServerHarnessValidationResult> | null>(null);
  const { copyToClipboard } = useCopyToClipboard<string>();

  const mutation = useMutation({
    ...validateHarnessesMutationOptions(),
    onSuccess: (results) => {
      setLastResolvedResults(results);
    },
  });

  const resultsByProvider = useMemo(
    () => new Map((lastResolvedResults ?? []).map((result) => [result.provider, result])),
    [lastResolvedResults],
  );

  const orderedResults = useMemo(
    () => HARNESSES.map((meta) => resultsByProvider.get(meta.provider) ?? null),
    [resultsByProvider],
  );

  const runValidation = useCallback(() => {
    setHasTriggered(true);
    const providerOptions = buildOnboardingProviderOptions(settings);
    mutation.mutate(providerOptions ? { providerOptions } : undefined);
  }, [mutation, settings]);

  const openDocs = useCallback(
    async (meta: HarnessMeta) => {
      try {
        const installUrl = new URL(meta.installUrl);
        if (installUrl.protocol !== "https:") {
          throw new Error(`Unsupported install URL: ${meta.installUrl}`);
        }
        await ensureNativeApi().shell.openExternal(installUrl.toString());
      } catch {
        toastManager.add({
          type: "error",
          title: "Couldn't open the link",
          description: meta.installUrl,
        });
        copyToClipboard(meta.installUrl, meta.installUrl);
      }
    },
    [copyToClipboard],
  );

  const ctaLabel = mutation.isPending ? "Checking…" : hasTriggered ? "Re-check" : "Check my setup";
  const mutationError =
    mutation.isError && mutation.error instanceof Error
      ? mutation.error.message
      : mutation.isError
        ? "Harness validation failed."
        : null;

  const summary = buildSummary({
    isPending: mutation.isPending,
    hasResults: lastResolvedResults !== null,
    results: orderedResults,
    totalCount: HARNESSES.length,
  });

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-2xl border border-border/70 bg-gradient-to-b from-background/60 to-background/30 p-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:delay-150 motion-safe:duration-500"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex gap-3">
          <div
            className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <HeartPulseIcon className="size-4" />
          </div>
          <div className="space-y-2">
            <h2 id={headingId} className="text-base font-medium text-foreground">
              Check your model harnesses
            </h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Verify that the CLI harnesses behind GPT and Claude models are installed and can
              answer a simple prompt before you start a thread.
            </p>
            <p className="text-xs text-muted-foreground/80">
              This checks harness connectivity only; MCP and project setup are not validated.
            </p>
          </div>
        </div>

        <Button
          className="shrink-0"
          disabled={mutation.isPending}
          onClick={runValidation}
        >
          {mutation.isPending ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : hasTriggered ? (
            <RefreshCcwIcon className="size-4" />
          ) : (
            <PlayCircleIcon className="size-4" />
          )}
          {ctaLabel}
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3" aria-live="polite">
        <div
          className="flex h-1.5 w-28 overflow-hidden rounded-full bg-muted-foreground/15"
          role="presentation"
        >
          {summary.segments.map((tone, index) => (
            <span
              key={index}
              className={cn(
                "h-full flex-1 transition-colors duration-300",
                SEGMENT_TONE_CLASSES[tone],
                index > 0 && "ml-px",
              )}
            />
          ))}
        </div>
        <span
          className={cn(
            "text-xs",
            summary.kind === "idle" ? "text-muted-foreground/80" : "text-muted-foreground",
          )}
        >
          {summary.kind === "pending" ? (
            <span className="inline-flex items-center gap-1.5">
              <LoaderCircleIcon
                className="size-3 animate-spin text-primary"
                aria-hidden="true"
              />
              {summary.label}
            </span>
          ) : (
            summary.label
          )}
        </span>
      </div>

      {mutationError ? (
        <div className="mt-4">
          <Alert variant="error">
            <AlertTitle>Harness validation failed</AlertTitle>
            <AlertDescription>{mutationError}</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={runValidation}>
                Try again
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}

      <ul
        aria-live="polite"
        aria-busy={mutation.isPending}
        aria-label="Harness validation results"
        className="mt-4 space-y-3"
      >
        {HARNESSES.map((meta, index) => (
          <HarnessRow
            key={meta.provider}
            meta={meta}
            result={resultsByProvider.get(meta.provider) ?? null}
            isPending={mutation.isPending}
            onOpenDocs={openDocs}
            animationDelayMs={150 + index * 75}
          />
        ))}
      </ul>
    </section>
  );
}
