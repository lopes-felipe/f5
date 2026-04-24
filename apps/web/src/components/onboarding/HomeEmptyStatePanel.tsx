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
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { HomeMissionControl } from "../home/HomeMissionControl";
import { HarnessValidationPanel } from "./HarnessValidationPanel";

type AccentToken = "blue" | "emerald" | "amber" | "violet";

// Static class strings so Tailwind's JIT can detect them at build time.
const ACCENT_CLASSES: Record<AccentToken, { chipBg: string; icon: string; hoverShadow: string }> = {
  amber: {
    chipBg: "bg-amber-500/10",
    hoverShadow: "hover:shadow-amber-500/20",
    icon: "text-amber-400",
  },
  blue: {
    chipBg: "bg-blue-500/10",
    hoverShadow: "hover:shadow-blue-500/20",
    icon: "text-blue-400",
  },
  emerald: {
    chipBg: "bg-emerald-500/10",
    hoverShadow: "hover:shadow-emerald-500/20",
    icon: "text-emerald-400",
  },
  violet: {
    chipBg: "bg-violet-500/10",
    hoverShadow: "hover:shadow-violet-500/20",
    icon: "text-violet-400",
  },
};

interface OnboardingFeature {
  readonly accent: AccentToken;
  readonly description: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly title: string;
}

const ONBOARDING_FEATURES: readonly OnboardingFeature[] = [
  {
    accent: "blue",
    description: "Run two agents in parallel to draft plans, cross-review, and merge.",
    icon: GitBranchIcon,
    title: "Planning workflows",
  },
  {
    accent: "emerald",
    description: "Independent review agents plus a consolidator produce one actionable summary.",
    icon: ShieldCheckIcon,
    title: "Automated code review",
  },
  {
    accent: "amber",
    description: "Attach external tools via stdio, SSE, or HTTP with per-project OAuth.",
    icon: PlugIcon,
    title: "MCP tool integration",
  },
  {
    accent: "violet",
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
    <section className="relative mx-auto flex w-full max-w-3xl flex-col gap-8 overflow-hidden px-6 py-8 motion-safe:animate-in motion-safe:fade-in-50 motion-safe:duration-300">
      {/* Decorative background orbs */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -right-16 -z-10 h-72 w-72 rounded-full bg-primary/20 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 -left-20 -z-10 h-56 w-56 rounded-full bg-violet-500/20 blur-3xl"
      />

      <header className="flex flex-col items-start gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-300">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/50 px-3 py-1 text-xs font-medium text-muted-foreground">
          <SparklesIcon className="size-3.5 text-primary" />
          Get started
        </span>
        <h1 className="font-heading text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
          Welcome to{" "}
          <span className="bg-gradient-to-br from-primary via-primary/80 to-violet-400 bg-clip-text text-transparent">
            {APP_BASE_NAME}
          </span>
        </h1>
        <p className="max-w-xl text-base text-muted-foreground">{subtitle}</p>
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
        "relative rounded-xl border border-border bg-background/50 p-4 text-left transition-all duration-200",
        "hover:border-primary/60 hover:bg-accent/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected ? "border-primary bg-primary/5 ring-2 ring-primary" : null,
      )}
      onClick={onClick}
    >
      {selected ? (
        <CheckCircle2Icon
          aria-hidden="true"
          className="absolute top-3 right-3 size-5 text-primary"
        />
      ) : null}

      <div className="mb-3 flex min-h-[72px] flex-col justify-center gap-1.5 rounded-md bg-background/40 p-3">
        {PROFILE_PREVIEW_BARS[name]}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {showRecommended ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
            <SparklesIcon className="size-3" />
            Recommended
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </button>
  );
}

export function HomeEmptyStatePanel() {
  const { settings, updateSettings } = useAppSettings();
  const { displayProfile, mode, showProfileOverwriteWarning } = useOnboardingLiteState();

  if (mode === "loading") {
    return null;
  }

  const selectedDisplayProfile: DisplayProfileName =
    displayProfile === "custom" ? "balanced" : displayProfile;
  const openAddProject = () => useCommandPaletteStore.getState().openAddProject();

  if (mode === "empty-projects") {
    return (
      <PanelShell
        subtitle="Add a project to get started."
        body={
          <div className="min-h-[320px] rounded-2xl border border-border bg-background/50 p-6">
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
          <div className="grid gap-3 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:delay-100 sm:grid-cols-2">
            {ONBOARDING_FEATURES.map(({ accent, description, icon: Icon, title }) => {
              const accentClasses = ACCENT_CLASSES[accent];
              return (
                <div
                  key={title}
                  className={cn(
                    "group rounded-2xl border border-border bg-gradient-to-b from-background/60 to-background/30 p-5 transition-all duration-200",
                    "hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-lg",
                    accentClasses.hoverShadow,
                  )}
                >
                  <div
                    className={cn(
                      "grid size-10 place-items-center rounded-lg",
                      accentClasses.chipBg,
                    )}
                  >
                    <Icon className={cn("size-5", accentClasses.icon)} />
                  </div>
                  <h2 className="mt-4 text-sm font-medium text-foreground">{title}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                </div>
              );
            })}
          </div>

          <HarnessValidationPanel />

          {/* Display profile */}
          <div className="border-t border-border/60 pt-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:delay-200 motion-safe:duration-500">
            <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <Settings2Icon className="size-4" />
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
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
                <span>{DISPLAY_PROFILE_CUSTOM_WARNING}</span>
              </p>
            ) : null}
          </div>
        </div>
      }
      footer={
        <div className="space-y-4 motion-safe:animate-in motion-safe:fade-in motion-safe:delay-300 motion-safe:duration-500">
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={openAddProject} className="shadow-lg shadow-primary/25">
              Add your first project
              <ArrowRightIcon className="size-4" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
            <p className="text-sm text-muted-foreground">
              Tip: press{" "}
              <kbd className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-xs text-foreground">
                ⌘K
              </kbd>{" "}
              anywhere to search commands.
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
