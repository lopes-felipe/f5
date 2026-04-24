import { isElectron } from "../../env";
import { SidebarInset } from "../ui/sidebar";
import { AboutSettings } from "./categories/AboutSettings";
import { DisplaySettings } from "./categories/DisplaySettings";
import { GeneralSettings } from "./categories/GeneralSettings";
import { IntegrationsSettings } from "./categories/IntegrationsSettings";
import { NotificationsSettings } from "./categories/NotificationsSettings";
import { ProjectsSettings } from "./categories/ProjectsSettings";
import { ProvidersSettings } from "./categories/ProvidersSettings";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_LABELS,
  type SettingsCategory,
} from "./settingsCategories";

interface SettingsLayoutProps {
  readonly category: SettingsCategory;
  readonly onCategoryChange: (category: SettingsCategory) => void;
}

function CategoryContent({ category }: { readonly category: SettingsCategory }) {
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
    case "about":
      return <AboutSettings />;
    default:
      return null;
  }
}

export function SettingsLayout({ category, onCategoryChange }: SettingsLayoutProps) {
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
                          onClick={() => onCategoryChange(candidate)}
                        >
                          {SETTINGS_CATEGORY_LABELS[candidate]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </nav>

              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
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
                        <CategoryContent category={candidate} />
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
