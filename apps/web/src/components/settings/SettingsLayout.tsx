import { SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { AboutSettings } from "./categories/AboutSettings";
import { ArchiveSettings } from "./categories/ArchiveSettings";
import { DisplaySettings } from "./categories/DisplaySettings";
import { GeneralSettings } from "./categories/GeneralSettings";
import { IntegrationsSettings } from "./categories/IntegrationsSettings";
import { NotificationsSettings } from "./categories/NotificationsSettings";
import { ProjectsSettings } from "./categories/ProjectsSettings";
import { ProvidersSettings } from "./categories/ProvidersSettings";
import { StorageSettings } from "./categories/StorageSettings";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_LABELS,
  filterSettingsItems,
  getSettingsItemDescriptor,
  type SettingsCategory,
} from "./settingsCategories";

interface SettingsLayoutProps {
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
    case "display":
      return <DisplaySettings />;
    case "notifications":
      return <NotificationsSettings />;
    case "providers":
      return <ProvidersSettings />;
    case "integrations":
      return <IntegrationsSettings />;
    case "projects":
      return <ProjectsSettings />;
    case "archive":
      return <ArchiveSettings />;
    case "storage":
      return active ? <StorageSettings /> : null;
    case "about":
      return <AboutSettings />;
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
  category,
  onCategoryChange,
  item,
  onItemChange,
}: SettingsLayoutProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const searchResults = useMemo(() => filterSettingsItems(searchQuery), [searchQuery]);
  const isSearching = searchQuery.trim().length > 0;

  const clearSearch = useCallback(() => {
    setSearchQuery("");
    setActiveSearchResultIndex(0);
  }, []);

  const selectSearchResult = useCallback(
    (resultId: string) => {
      clearSearch();
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
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea") ||
          target.isContentEditable ||
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
  }, [category, item, reducedMotion]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden p-6">
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
              <nav
                aria-label="Settings categories"
                className="lg:sticky lg:top-6 lg:w-60 lg:self-start"
              >
                <div className="rounded-2xl border border-border bg-card p-3">
                  <div className="relative mb-3">
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
                              className={`flex w-full flex-col rounded-lg px-2.5 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ${
                                index === activeSearchResultIndex ? "bg-accent" : ""
                              }`}
                              onMouseMove={() => setActiveSearchResultIndex(index)}
                              onClick={() => selectSearchResult(result.id)}
                            >
                              <span className="text-xs font-medium text-foreground">
                                {result.label}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {SETTINGS_CATEGORY_LABELS[result.category]}
                              </span>
                            </button>
                          ))
                        ) : (
                          <p className="px-2.5 py-2 text-xs text-muted-foreground">
                            No settings found.
                          </p>
                        )}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1">
                    {SETTINGS_CATEGORIES.map((candidate) => {
                      const selected = candidate === category;
                      return (
                        <button
                          key={candidate}
                          type="button"
                          aria-current={selected ? "page" : undefined}
                          className={`rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                            selected
                              ? "bg-primary/8 text-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          }`}
                          onClick={() => {
                            clearSearch();
                            onCategoryChange(candidate);
                          }}
                        >
                          {SETTINGS_CATEGORY_LABELS[candidate]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </nav>

              <div ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
                <div className="flex flex-col gap-6">
                  {SETTINGS_CATEGORIES.map((candidate) => {
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
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
