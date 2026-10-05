import {
  AlertCircleIcon,
  ArrowRightIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  GitForkIcon,
  PlugIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { APP_BASE_NAME } from "../../branding";
import {
  DISPLAY_PROFILE_CUSTOM_WARNING,
  DISPLAY_PROFILE_DESCRIPTIONS,
  DISPLAY_PROFILE_LABELS,
  DISPLAY_PROFILE_NAMES,
  displayProfilePatchFor,
  type DisplayProfileName,
  useAppSettings,
} from "../../appSettings";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { useOnboardingLiteState } from "../../lib/onboardingLite";
import { useStartupReady } from "../../lib/startupReady";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { HomeMissionControl } from "../home/HomeMissionControl";
import { Kbd } from "../ui/kbd";
import { SectionLabel } from "../ui/section-label";
import { Skeleton } from "../ui/skeleton";
import { HarnessValidationPanel } from "./HarnessValidationPanel";

type AccentToken = "info" | "success" | "warning" | "attention";

// Static class strings so Tailwind's JIT can detect them at build time.
const ACCENT_CLASSES: Record<AccentToken, { chipBg: string; icon: string }> = {
  attention: { chipBg: "bg-attention/10", icon: "text-attention-foreground" },
  info: { chipBg: "bg-info/10", icon: "text-info-foreground" },
  success: { chipBg: "bg-success/10", icon: "text-success-foreground" },
  warning: { chipBg: "bg-warning/10", icon: "text-warning-foreground" },
};

interface OnboardingFeature {
  readonly accent: AccentToken;
  readonly description: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly title: string;
}

const ONBOARDING_FEATURES: readonly OnboardingFeature[] = [
  {
    accent: "info",
    description: "Run two agents in parallel to draft plans, cross-review, and merge.",
    icon: GitBranchIcon,
    title: "Planning workflows",
  },
  {
    accent: "success",
    description: "Independent review agents plus a consolidator produce one actionable summary.",
    icon: ShieldCheckIcon,
    title: "Automated code review",
  },
  {
    accent: "warning",
    description: "Attach external tools via stdio, SSE, or HTTP with per-project OAuth.",
    icon: PlugIcon,
    title: "MCP tool integration",
  },
  {
    accent: "attention",
    description: "Run implementation phases in isolated git worktrees to avoid conflicts.",
    icon: GitForkIcon,
    title: "Worktree isolation",
  },
] as const;

// Mini density previews used on the display-profile cards.
const PROFILE_PREVIEW_BARS: Record<DisplayProfileName, ReactNode> = {
  balanced: (
    <>
      <div className="h-1 w-10 rounded-full bg-foreground/35" />
      <div className="h-1 w-16 rounded-full bg-foreground/25" />
      <div className="h-1 w-12 rounded-full bg-foreground/25" />
      <div className="h-1 w-14 rounded-full bg-foreground/25" />
    </>
  ),
  detailed: (
    <>
      <div className="h-1 w-10 rounded-full bg-foreground/35" />
      <div className="h-1 w-16 rounded-full bg-foreground/25" />
      <div className="h-2 w-20 rounded-sm bg-primary/30" />
      <div className="h-1 w-14 rounded-full bg-foreground/25" />
      <div className="h-1 w-12 rounded-full bg-foreground/25" />
      <div className="h-1 w-16 rounded-full bg-foreground/25" />
    </>
  ),
  minimal: (
    <>
      <div className="h-1 w-8 rounded-full bg-foreground/35" />
      <div className="h-1 w-6 rounded-full bg-foreground/25" />
    </>
  ),
};

interface PanelShellProps {
  readonly body: ReactNode;
  readonly footer?: ReactNode;
  readonly subtitle: string;
}

function PanelShell({ body, footer, subtitle }: PanelShellProps) {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-10 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-300">
      <header className="flex flex-col items-start gap-2">
        <SectionLabel as="span">Get started</SectionLabel>
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          Welcome to {APP_BASE_NAME}
        </h1>
        <p className="max-w-xl text-sm text-muted-foreground">{subtitle}</p>
      </header>
      {body}
      {footer}
    </section>
  );
}

function DisplayProfileCard({
  description,
  label,
  name,
  onClick,
  selected,
  showRecommended,
}: {
  readonly description: string;
  readonly label: string;
  readonly name: DisplayProfileName;
  readonly onClick: () => void;
  readonly selected: boolean;
  readonly showRecommended?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "relative rounded-xl border border-border bg-card p-4 text-left transition-colors duration-(--duration-fast)",
        "hover:bg-accent/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected ? "border-primary bg-accent/40 ring-1 ring-primary" : null,
      )}
      onClick={onClick}
    >
      {selected ? (
        <CheckCircle2Icon
          aria-hidden="true"
          className="absolute top-3 right-3 size-4 text-primary"
        />
      ) : null}

      <div className="mb-3 flex min-h-18 flex-col justify-center gap-1.5 rounded-md bg-muted/40 p-3">
        {PROFILE_PREVIEW_BARS[name]}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {showRecommended ? (
          <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-2xs font-medium text-muted-foreground">
            <SparklesIcon className="size-3" />
            Recommended
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </button>
  );
}

function HomeStartupSkeleton() {
  return (
    <section
      className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10"
      role="status"
      aria-live="polite"
      aria-label="Loading workspace"
      data-testid="home-startup-skeleton"
    >
      <span className="sr-only">Loading workspace</span>
      {/* Mirrors the dashboard: greeting, quick-start card, then rows. */}
      <div aria-hidden="true" className="flex flex-col gap-4">
        <Skeleton className="h-9 w-[min(18rem,70vw)] rounded-md" />
        <div className="rounded-xl border border-border bg-card p-4">
          <Skeleton className="h-4 w-[min(16rem,60vw)] rounded-full" />
          <div className="mt-12 flex items-center gap-2">
            <Skeleton className="h-7 w-28 rounded-md" />
            <Skeleton className="h-7 w-24 rounded-md" />
            <Skeleton className="ms-auto h-7 w-16 rounded-md" />
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="flex flex-col gap-1.5">
        <Skeleton className="h-3 w-20 rounded-full" />
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="flex h-10 items-center gap-3 px-2.5">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-3 w-20 rounded-full" />
            <Skeleton className="h-3.5 w-[min(20rem,45vw)] rounded-full" />
            <Skeleton className="ms-auto h-3 w-10 rounded-full" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function HomeEmptyStatePanel() {
  const { settings, updateSettings } = useAppSettings();
  const { displayProfile, mode, showProfileOverwriteWarning } = useOnboardingLiteState();
  const startupReady = useStartupReady();

  if (!startupReady || mode === "loading") {
    return <HomeStartupSkeleton />;
  }

  const selectedDisplayProfile: DisplayProfileName =
    displayProfile === "custom" ? "balanced" : displayProfile;
  const openAddProject = () => useCommandPaletteStore.getState().openAddProject();

  if (mode === "empty-projects") {
    return (
      <PanelShell
        subtitle="Add a project to get started."
        body={
          <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">
              Connect a workspace to create threads, run agents, and keep work isolated per project.
            </p>
          </div>
        }
        footer={
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={openAddProject}>Add a project</Button>
          </div>
        }
      />
    );
  }

  if (mode === "empty-threads") {
    return <HomeMissionControl />;
  }

  return (
    <PanelShell
      subtitle="Set up your first workspace and choose how much detail the chat view should show."
      body={
        <div className="space-y-8">
          {/* Feature grid */}
          <div className="grid gap-3 sm:grid-cols-2">
            {ONBOARDING_FEATURES.map(({ accent, description, icon: Icon, title }) => {
              const accentClasses = ACCENT_CLASSES[accent];
              return (
                <div key={title} className="rounded-xl border border-border bg-card p-4">
                  <div
                    className={cn(
                      "grid size-8 place-items-center rounded-lg",
                      accentClasses.chipBg,
                    )}
                  >
                    <Icon className={cn("size-4", accentClasses.icon)} />
                  </div>
                  <h2 className="mt-3 text-sm font-medium text-foreground">{title}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                </div>
              );
            })}
          </div>

          <HarnessValidationPanel />

          {/* Display profile */}
          <div className="border-t border-border pt-6">
            <div className="mb-1 flex items-center gap-2 text-2xs font-medium text-muted-foreground">
              <Settings2Icon className="size-3.5" />
              <span>Display profile</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Choose how much detail appears in threads. You can change this any time in Settings →
              Display.
            </p>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {DISPLAY_PROFILE_NAMES.map((name) => (
                <DisplayProfileCard
                  key={name}
                  description={DISPLAY_PROFILE_DESCRIPTIONS[name]}
                  label={DISPLAY_PROFILE_LABELS[name]}
                  name={name}
                  onClick={() => {
                    if (displayProfile === name) {
                      return;
                    }
                    updateSettings(displayProfilePatchFor(name));
                  }}
                  selected={selectedDisplayProfile === name}
                  showRecommended={name === "balanced"}
                />
              ))}
            </div>

            {showProfileOverwriteWarning ? (
              <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                <span>{DISPLAY_PROFILE_CUSTOM_WARNING}</span>
              </p>
            ) : null}
          </div>
        </div>
      }
      footer={
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={openAddProject}>
              Add your first project
              <ArrowRightIcon className="size-4" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">
              Tip: press <Kbd>⌘K</Kbd> anywhere to search commands.
            </p>
            <label className="flex items-center gap-3 text-sm text-muted-foreground">
              <Checkbox
                checked={settings.onboardingLiteStatus === "dismissed"}
                onCheckedChange={(checked) =>
                  updateSettings({
                    onboardingLiteStatus:
                      checked === true
                        ? "dismissed"
                        : settings.onboardingLiteStatus === "reopened"
                          ? "reopened"
                          : "eligible",
                  })
                }
              />
              <span>Don&apos;t show this again</span>
            </label>
          </div>
        </div>
      }
    />
  );
}
