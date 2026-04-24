import { PlayIcon, MessageCircleIcon } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TabTargetKey } from "../tabTargets";
import ThreadCyclePicker, { type PickerItem } from "./ThreadCyclePicker";

function targetKey(value: string): TabTargetKey {
  return value;
}

const items: readonly PickerItem[] = [
  {
    id: targetKey("thread:thread-a"),
    title: "Alpha thread",
    subtitle: "Project A",
    badgeLabel: null,
    threadStatusPill: {
      label: "Working",
      colorClass: "text-sky-600",
      dotClass: "bg-sky-500",
      chipClass: "bg-sky-500/10 text-sky-700 ring-1 ring-sky-500/20",
      icon: PlayIcon,
      pulse: true,
    },
    isDraft: false,
    isStale: false,
  },
  {
    id: targetKey("settings"),
    title: "Settings",
    subtitle: "Providers & Models",
    badgeLabel: "Settings",
    threadStatusPill: null,
    isDraft: false,
    isStale: false,
  },
  {
    id: targetKey("planningWorkflow:workflow-1"),
    title: "Feature workflow",
    subtitle: "Project B",
    badgeLabel: "Feature",
    threadStatusPill: null,
    isDraft: false,
    isStale: false,
  },
  {
    id: targetKey("thread:thread-b"),
    title: "Draft thread",
    subtitle: "Project B",
    badgeLabel: null,
    threadStatusPill: {
      label: "Awaiting Input",
      colorClass: "text-indigo-600",
      dotClass: "bg-indigo-500",
      chipClass: "bg-indigo-500/10 text-indigo-700 ring-1 ring-indigo-500/20",
      icon: MessageCircleIcon,
      pulse: false,
    },
    isDraft: true,
    isStale: false,
  },
  {
    id: targetKey("codeReviewWorkflow:workflow-2"),
    title: "Removed workflow",
    subtitle: null,
    badgeLabel: "Review",
    threadStatusPill: null,
    isDraft: false,
    isStale: true,
  },
];

function renderPicker(currentItemId: TabTargetKey | null = targetKey("thread:thread-a")): string {
  return renderToStaticMarkup(
    <ThreadCyclePicker
      items={items}
      currentIndex={1}
      currentItemId={currentItemId}
      onSelect={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe("ThreadCyclePicker", () => {
  it("renders all items in order with their titles", () => {
    const markup = renderPicker();

    expect(markup).toContain("Alpha thread");
    expect(markup).toContain("Settings");
    expect(markup).toContain("Feature workflow");
    expect(markup).toContain("Draft thread");
    expect(markup).toContain("Removed workflow");
    expect(markup.indexOf("Alpha thread")).toBeLessThan(markup.indexOf("Settings"));
    expect(markup.indexOf("Settings")).toBeLessThan(markup.indexOf("Feature workflow"));
  });

  it("marks the highlighted item as selected with accent styling", () => {
    const markup = renderPicker();

    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("bg-accent");
    expect(markup).toContain("text-accent-foreground");
  });

  it("renders subtitles, thread status pills, route badges, and the draft badge when provided", () => {
    const markup = renderPicker();

    expect(markup).toContain("Project A");
    expect(markup).toContain("Providers &amp; Models");
    expect(markup).toContain("Project B");
    expect(markup).toContain(">Working<");
    expect(markup).toContain(">Awaiting Input<");
    expect(markup).toContain(">Settings<");
    expect(markup).toContain(">Feature<");
    expect(markup).toContain(">Review<");
    expect(markup).toContain(">Draft<");
  });

  it("renders thread status pills on the left side before the thread title", () => {
    const markup = renderPicker();

    expect(markup.indexOf("Working")).toBeLessThan(markup.indexOf("Alpha thread"));
    expect(markup.indexOf("Awaiting Input")).toBeLessThan(markup.indexOf("Draft thread"));
  });

  it("renders stale items as disabled with strikethrough styling", () => {
    const markup = renderPicker();

    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("line-through");
    expect(markup).toContain("cursor-not-allowed");
  });

  it("shows the current marker only for the matching active target", () => {
    const withCurrentItem = renderPicker(targetKey("thread:thread-a"));
    const withoutCurrentItem = renderPicker(null);

    expect(withCurrentItem).toContain('data-slot="thread-cycle-picker-current-marker"');
    expect(withoutCurrentItem).not.toContain('data-slot="thread-cycle-picker-current-marker"');
  });

  it("renders a live region for the highlighted title", () => {
    const markup = renderPicker();

    expect(markup).toContain('data-slot="thread-cycle-picker-live-region"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain(">Settings<");
  });

  it("renders keyboard-hint footer with Tab, Shift+Tab, and Esc hints", () => {
    const markup = renderPicker();

    expect(markup).toContain('data-slot="thread-cycle-picker-footer"');
    expect(markup).toContain(">Tab<");
    expect(markup).toContain(">Shift<");
    expect(markup).toContain(">Esc<");
    expect(markup).toContain(">Next<");
    expect(markup).toContain(">Previous<");
    expect(markup).toContain(">Cancel<");
  });

  it("uses switch-tab copy for the listbox label and heading", () => {
    const markup = renderPicker();

    expect(markup).toContain('aria-label="Switch Tab"');
    expect(markup).toContain(">Switch Tab<");
  });
});
