import { SETTINGS_CATEGORY_ICONS } from "./settingsCategoryIcons";
import { useServerCapability } from "../../protocolState";
import { SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useReducedMotion } from "../../hooks/useReducedMotion";
import { AppTitlebar } from "../AppTitlebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { AboutSettings } from "./categories/AboutSettings";
import { AppearanceSettings } from "./categories/AppearanceSettings";
import { ArchiveSettings } from "./categories/ArchiveSettings";
import { AccountsSettings } from "./categories/AccountsSettings";
import { BrowserComputerSettings } from "./categories/BrowserComputerSettings";
import { ConversationSettings } from "./categories/ConversationSettings";
import { GeneralSettings } from "./categories/GeneralSettings";
import { GitSettings } from "./categories/GitSettings";
import { KeyboardSettings } from "./categories/KeyboardSettings";
import { NotificationsSettings } from "./categories/NotificationsSettings";
import { ProjectSettings } from "./categories/ProjectSettings";
import { ProjectsSettings } from "./categories/ProjectsSettings";
import { ProvidersSettings } from "./categories/ProvidersSettings";
import { StorageSettings } from "./categories/StorageSettings";
import { ThreadsSettings } from "./categories/ThreadsSettings";
import { ToolsSettings } from "./categories/ToolsSettings";
import {
  ProjectBrowserOverrides,
  ProjectGitOverrides,
  ProjectScopeGate,
  ProjectScopeProvider,
  ProjectThreadsOverrides,
  ProjectToolsOverrides,
} from "./ProjectSettingsScope";
import type { ProjectId } from "@t3tools/contracts";
import { cn } from "../../lib/utils";
import { SectionLabel } from "../ui/section-label";
import { resolveSettingsSearchShortcut } from "./settingsSearchShortcut";
import {
  SETTINGS_CATEGORY_LABELS,
  filterSettingsItems,
  getSettingsItemDescriptor,
  settingsCategoriesForScope,
  settingsCategoryGroupsForScope,
  type SettingsCategory,
  type SettingsScope,
} from "./settingsCategories";

interface SettingsLayoutProps {
  readonly scopeHeader?: ReactNode;
  /** Set when a project scope is selected; the layout then shows only project pages. */
  readonly projectId?: ProjectId | undefined;
  readonly projectName?: string | null | undefined;
  /** The scoped project was deleted or never existed. */
  readonly projectUnavailable?: boolean;
  readonly category: SettingsCategory;
  readonly onCategoryChange: (category: SettingsCategory) => void;
  readonly item?: string | undefined;
  readonly onItemChange?: (item: string) => void;
}

function CategoryContent({
  category,
  active,
}: {
  readonly category: SettingsCategory;
  readonly active: boolean;
}) {
  switch (category) {
    case "general":
      return <GeneralSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "conversation":
      return <ConversationSettings />;
    case "keyboard":
      return <KeyboardSettings />;
    case "notifications":
      return <NotificationsSettings />;
    case "providers":
      return <ProvidersSettings />;
    case "threads":
      return <ThreadsSettings />;
    case "tools":
      return <ToolsSettings />;
    case "browser":
      return <BrowserComputerSettings />;
    case "projects":
      return <ProjectsSettings />;
    case "git":
      return <GitSettings />;
    case "accounts":
      return active ? <AccountsSettings /> : null;
    case "storage":
      return active ? <StorageSettings /> : null;
    case "archive":
      return <ArchiveSettings />;
    case "about":
      return <AboutSettings />;
    default:
      return null;
  }
}

function ProjectCategoryContent({ category }: { readonly category: SettingsCategory }) {
  switch (category) {
    case "project":
      return <ProjectSettings />;
    case "threads":
      return (
        <ProjectScopeGate>
          <ProjectThreadsOverrides />
        </ProjectScopeGate>
      );
    case "tools":
      return (
        <ProjectScopeGate>
          <ProjectToolsOverrides />
        </ProjectScopeGate>
      );
    case "browser":
      return (
        <ProjectScopeGate>
          <ProjectBrowserOverrides />
        </ProjectScopeGate>
      );
    case "git":
      return (
        <ProjectScopeGate>
          <ProjectGitOverrides />
        </ProjectScopeGate>
      );
    default:
      return null;
  }
}

const SETTINGS_HIGHLIGHT_CLASSES = [
  "ring-2",
  "ring-primary/50",
  "ring-offset-2",
  "ring-offset-background",
] as const;

function isNativelyFocusable(element: HTMLElement): boolean {
  return element.matches('a[href], button, input, select, textarea, [contenteditable="true"]');
}

export function SettingsLayout({
  scopeHeader,
  projectId,
  projectName,
  projectUnavailable = false,
  category,
  onCategoryChange,
  item,
  onItemChange,
}: SettingsLayoutProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const [selectionNonce, setSelectionNonce] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const composerRedesign = useServerCapability("composer-redesign");
  const scope: SettingsScope = projectId ? "project" : "global";
  const categoryGroups = settingsCategoryGroupsForScope(scope);
  const scopeCategories = settingsCategoriesForScope(scope);
  const searchResults = useMemo(
    () =>
      filterSettingsItems(searchQuery, { scope }).filter(
        (item) => composerRedesign || item.id !== "conversation.composer-collapse",
      ),
    [searchQuery, composerRedesign, scope],
  );
  const isSearching = searchQuery.trim().length > 0;

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);

  const selectSearchResult = useCallback(
    (resultId: string) => {
      clearSearch();
      setSelectionNonce((value) => value + 1);
      onItemChange?.(resultId);
    },
    [clearSearch, onItemChange],
  );

  useEffect(() => {
    setActiveSearchResultIndex((index) =>
      searchResults.length === 0 ? 0 : Math.min(index, searchResults.length - 1),
    );
  }, [searchResults.length]);

  useEffect(() => {
    const activeResult = searchResults[activeSearchResultIndex];
    if (!activeResult) return;
    document
      .getElementById(`settings-search-result-${activeResult.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeSearchResultIndex, searchResults]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const shortcut = resolveSettingsSearchShortcut(event);
      if (!shortcut) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ((shortcut === "slash" &&
          (target.matches("input, textarea") || target.isContentEditable)) ||
          // Keep focus inside open dialogs and popups instead of escaping their focus trap.
          target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]'))
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (!isSearching) return;
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !searchContainerRef.current?.contains(event.target)) {
        clearSearch();
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", dismissOnOutsidePointer);
  }, [clearSearch, isSearching]);

  useEffect(() => {
    const descriptor = getSettingsItemDescriptor(item);
    if (!descriptor || descriptor.category !== category) return;

    let animationFrame = 0;
    let highlightTimeout = 0;
    let attempts = 0;
    let target: HTMLElement | null = null;
    let addedTabIndex = false;

    const focusTarget = () => {
      const panel = contentRef.current?.querySelector<HTMLElement>(
        `[data-settings-category-panel="${category}"]`,
      );
      target = panel?.querySelector<HTMLElement>(descriptor.targetSelector) ?? null;
      if (!target && attempts < 12) {
        attempts += 1;
        animationFrame = window.requestAnimationFrame(focusTarget);
        return;
      }
      if (!target) return;

      target.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "center",
      });
      if (!isNativelyFocusable(target) && !target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
        addedTabIndex = true;
      }
      target.focus({ preventScroll: true });
      target.dataset.settingsSearchHighlighted = "true";
      target.classList.add(...SETTINGS_HIGHLIGHT_CLASSES);
      highlightTimeout = window.setTimeout(() => {
        target?.classList.remove(...SETTINGS_HIGHLIGHT_CLASSES);
        target?.removeAttribute("data-settings-search-highlighted");
        if (addedTabIndex) target?.removeAttribute("tabindex");
      }, 1_800);
    };

    animationFrame = window.requestAnimationFrame(focusTarget);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(highlightTimeout);
      target?.classList.remove(...SETTINGS_HIGHLIGHT_CLASSES);
      target?.removeAttribute("data-settings-search-highlighted");
      if (addedTabIndex) target?.removeAttribute("tabindex");
    };
  }, [category, item, reducedMotion, selectionNonce]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <AppTitlebar webVisibility="mobile-only" />

        {scopeHeader}
        {/* Below lg the nav stacks above the content, so the whole page scrolls; at lg and up
            the nav stays put and only the content column scrolls. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6 lg:overflow-hidden">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 lg:h-full">
            <header className="space-y-1">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-ui text-muted-foreground">
                {!projectId
                  ? "Settings for this profile."
                  : projectUnavailable
                    ? "This project is unavailable or was deleted. Switch to Global or another project."
                    : `Overrides for ${projectName ?? "this project"}. Anything not overridden uses the global settings.`}
              </p>
            </header>

            <div className="flex flex-col gap-6 lg:min-h-0 lg:flex-1 lg:flex-row lg:gap-8">
              <nav
                aria-label="Settings categories"
                className="lg:flex lg:min-h-0 lg:w-56 lg:shrink-0 lg:flex-col"
              >
                <div className="contents">
                  <div ref={searchContainerRef} className="relative mb-3 lg:shrink-0">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      nativeInput
                      type="search"
                      size="sm"
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.currentTarget.value);
                        setActiveSearchResultIndex(0);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape" && isSearching) {
                          event.preventDefault();
                          clearSearch();
                          return;
                        }
                        if (searchResults.length === 0) return;
                        if (event.key === "ArrowDown") {
                          event.preventDefault();
                          setActiveSearchResultIndex((index) => (index + 1) % searchResults.length);
                          return;
                        }
                        if (event.key === "ArrowUp") {
                          event.preventDefault();
                          setActiveSearchResultIndex(
                            (index) => (index - 1 + searchResults.length) % searchResults.length,
                          );
                          return;
                        }
                        if (event.key === "Enter") {
                          const result = searchResults[activeSearchResultIndex];
                          if (!result) return;
                          event.preventDefault();
                          selectSearchResult(result.id);
                        }
                      }}
                      aria-label="Search settings"
                      placeholder="Search settings"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={isSearching && searchResults.length > 0}
                      aria-controls={
                        isSearching && searchResults.length > 0
                          ? "settings-search-results"
                          : undefined
                      }
                      aria-activedescendant={
                        isSearching && searchResults[activeSearchResultIndex]
                          ? `settings-search-result-${searchResults[activeSearchResultIndex].id}`
                          : undefined
                      }
                      className="[&_input]:px-8"
                    />
                    {isSearching ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Clear settings search"
                        className="absolute top-1/2 right-1 z-10 size-5 -translate-y-1/2"
                        onClick={() => {
                          clearSearch();
                          searchInputRef.current?.focus();
                        }}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    ) : null}
                    {isSearching ? (
                      <div
                        id="settings-search-results"
                        role="listbox"
                        aria-label="Settings search results"
                        className="absolute top-full right-0 left-0 z-20 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
                      >
                        {searchResults.length > 0 ? (
                          searchResults.map((result, index) => (
                            <button
                              key={result.id}
                              id={`settings-search-result-${result.id}`}
                              type="button"
                              role="option"
                              aria-selected={index === activeSearchResultIndex}
                              tabIndex={-1}
                              className={cn(
                                "flex w-full flex-col rounded-lg px-2.5 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                                index === activeSearchResultIndex && "bg-accent",
                              )}
                              onMouseMove={() => setActiveSearchResultIndex(index)}
                              onClick={() => selectSearchResult(result.id)}
                            >
                              <span className="text-ui font-medium text-foreground">
                                {result.label}
                              </span>
                              <span className="text-2xs text-muted-foreground">
                                {SETTINGS_CATEGORY_LABELS[result.category]}
                              </span>
                            </button>
                          ))
                        ) : (
                          <p className="px-2.5 py-2 text-ui text-muted-foreground">
                            No settings found.
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                  {/* Scrolls on its own so short desktop windows can reach every page. */}
                  <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-y-auto">
                    {categoryGroups.map((group) => (
                      <div
                        key={group.id}
                        role="group"
                        aria-label={
                          group.label ?? SETTINGS_CATEGORY_LABELS[group.categories[0] ?? "about"]
                        }
                        className="flex flex-col gap-0.5"
                      >
                        {group.label ? (
                          <SectionLabel as="div" className="px-2">
                            {group.label}
                          </SectionLabel>
                        ) : null}
                        {group.categories.map((candidate) => {
                          const selected = candidate === category;
                          const Icon = SETTINGS_CATEGORY_ICONS[candidate];
                          return (
                            <button
                              key={candidate}
                              type="button"
                              aria-current={selected ? "page" : undefined}
                              className={cn(
                                "flex h-8 items-center gap-2 rounded-md px-2 text-left text-ui outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
                                selected
                                  ? "bg-accent font-medium text-foreground"
                                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                              )}
                              onClick={() => {
                                clearSearch();
                                onCategoryChange(candidate);
                              }}
                            >
                              <Icon
                                aria-hidden="true"
                                className={cn(
                                  "size-4 shrink-0",
                                  selected ? "text-foreground" : "text-faint-foreground",
                                )}
                              />
                              {SETTINGS_CATEGORY_LABELS[candidate]}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </nav>

              <div
                ref={contentRef}
                className="min-w-0 pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
              >
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
                  {projectId ? (
                    <ProjectScopeProvider key={projectId} projectId={projectId}>
                      {scopeCategories.map((candidate) => (
                        <div
                          key={candidate}
                          data-settings-category-panel={candidate}
                          className="flex flex-col gap-8"
                          hidden={candidate !== category}
                          aria-hidden={candidate !== category}
                        >
                          <ProjectCategoryContent category={candidate} />
                        </div>
                      ))}
                    </ProjectScopeProvider>
                  ) : (
                    scopeCategories.map((candidate) => {
                      const selected = candidate === category;
                      return (
                        // Keep category subtrees mounted so draft/edit state survives tab switches.
                        <div
                          key={candidate}
                          data-settings-category-panel={candidate}
                          className="flex flex-col gap-8"
                          hidden={!selected}
                          aria-hidden={!selected}
                        >
                          <CategoryContent category={candidate} active={selected} />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
