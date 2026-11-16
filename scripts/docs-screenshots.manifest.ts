/**
 * Docs screenshots captured by `bun run screenshots:capture`. Each entry
 * renders one image at `docs/images/<id>.webp`. README and workflow images are
 * captured separately by `apps/web/scripts/capture-readme-screenshots.mjs`.
 *
 * Routes run against the seeded demo state from
 * `apps/server/scripts/seed-demo.ts`; thread, project and workflow ids below
 * are the seeder's stable ids.
 *
 * Locators prefer roles, visible text and existing data attributes so shots
 * survive styling changes. `css` accepts any Playwright selector, including
 * `>> nth=<n>` chains.
 */

export type ShotLocator =
  | {
      readonly role: "button" | "link" | "tab" | "menuitem" | "dialog" | "heading" | "option";
      readonly name: string;
    }
  | { readonly text: string }
  | { readonly css: string };

export type ShotStep =
  | { readonly click: ShotLocator; readonly modifiers?: ReadonlyArray<"Shift" | "Meta"> }
  | { readonly fill: ShotLocator; readonly value: string }
  | { readonly waitFor: ShotLocator }
  | { readonly scrollIntoView: ShotLocator };

/**
 * `"page"` captures the viewport. A locator captures that element. `union`
 * captures the smallest rectangle around every listed element plus padding,
 * which keeps a popup and the control that opened it in one image.
 */
export type ShotTarget =
  | "page"
  | ShotLocator
  | { readonly union: ReadonlyArray<ShotLocator>; readonly padding?: number };

export interface DocsShot {
  readonly id: string;
  /** Path and query, relative to the server origin. */
  readonly route: string;
  /** Visible before any step runs; guards against capturing a loading state. */
  readonly waitFor: ShotLocator;
  readonly steps?: ReadonlyArray<ShotStep>;
  readonly target?: ShotTarget;
  readonly viewport?: { readonly width: number; readonly height: number };
}

const THREAD_POSTGRES = "/thread-snippet-postgres";
const THREAD_OPML = "/thread-rss-opml";

const HOME_READY: ShotLocator = { css: '[aria-label="Quick start"]' };
const COMPOSER: ShotLocator = { css: '[data-slot="composer-dock"]' };
const MODEL_PICKER: ShotLocator = { css: '[data-chat-provider-model-picker="true"]' };
const POPOVER: ShotLocator = { css: '[data-slot="popover-popup"]' };
// Model rows carry a favorites toggle; group headers do not.
const MODEL_ROW =
  '[data-slot="popover-popup"] [role="group"] > div:has(> button[aria-label$="favorites"])';
const SETTINGS_READY: ShotLocator = { css: 'input[placeholder="Search settings"]' };

export const DOCS_SHOTS: ReadonlyArray<DocsShot> = [
  // Getting started.
  {
    id: "getting-started-add-project",
    route: "/",
    waitFor: HOME_READY,
    steps: [{ click: { role: "button", name: "Add project" } }],
    target: { css: '[data-sidebar="sidebar"]' },
    viewport: { width: 1440, height: 720 },
  },
  {
    id: "getting-started-model-picker",
    route: THREAD_POSTGRES,
    waitFor: { text: "Changed files" },
    steps: [{ click: MODEL_PICKER }, { waitFor: POPOVER }],
    target: { union: [COMPOSER, POPOVER], padding: 16 },
  },
  {
    id: "getting-started-runtime-mode",
    route: THREAD_POSTGRES,
    waitFor: { text: "Changed files" },
    steps: [
      { click: { css: '[data-composer-control="runtimeMode"]' } },
      { waitFor: { css: '[role="menu"]' } },
    ],
    target: { union: [COMPOSER, { css: '[role="menu"]' }], padding: 16 },
  },
  {
    // The inline file-change card the guide describes. The Diff panel itself
    // is shown in assets/screenshots/thread.png, captured by
    // apps/web/scripts/capture-readme-screenshots.mjs.
    id: "getting-started-diff",
    route: THREAD_OPML,
    waitFor: { text: "Edit src/cli/mod.rs" },
    steps: [{ scrollIntoView: { text: "Edit src/cli/mod.rs" } }],
  },

  // Usage.
  {
    id: "usage-activity",
    route: "/usage?tab=activity&range=24h",
    waitFor: { text: "Usage over time" },
  },
  {
    id: "usage-breakdown",
    route: "/usage?tab=activity&range=24h",
    waitFor: { text: "Usage over time" },
    steps: [{ scrollIntoView: { text: "Projects and threads" } }],
  },
  {
    id: "usage-prices",
    route: "/usage?tab=activity&range=24h",
    waitFor: { text: "Usage over time" },
    steps: [{ click: { text: "Usage prices" } }, { scrollIntoView: { text: "Usage prices" } }],
  },

  // Settings.
  {
    id: "settings-providers",
    route: "/settings?category=providers",
    waitFor: SETTINGS_READY,
  },
  {
    id: "settings-project",
    route: "/settings?category=project&project=project-todo-cli",
    waitFor: { text: "Checked-in configuration" },
  },
  { id: "settings-storage", route: "/settings?category=storage", waitFor: SETTINGS_READY },
  { id: "settings-browser", route: "/settings?category=browser", waitFor: SETTINGS_READY },
  { id: "settings-keyboard", route: "/settings?category=keyboard", waitFor: SETTINGS_READY },

  // Attachments.
  {
    id: "attachments-message",
    route: THREAD_OPML,
    waitFor: { text: "opml-edge-cases.md" },
    steps: [{ scrollIntoView: { text: "opml-edge-cases.md" } }],
  },
  {
    id: "attachments-viewer",
    route: THREAD_OPML,
    waitFor: { text: "opml-edge-cases.md" },
    steps: [{ click: { text: "opml-edge-cases.md" } }, { waitFor: { text: "Duplicate URLs" } }],
    target: { css: '[role="dialog"]' },
  },

  // Worktrees: one message to several models.
  {
    id: "worktrees-multi-model",
    route: "/",
    waitFor: HOME_READY,
    steps: [
      { click: { role: "button", name: "New thread" } },
      { click: MODEL_PICKER },
      { waitFor: POPOVER },
      { click: { css: `${MODEL_ROW} >> nth=1` }, modifiers: ["Shift"] },
      { click: { css: `${MODEL_ROW} >> nth=3` }, modifiers: ["Shift"] },
    ],
    target: { union: [COMPOSER, POPOVER], padding: 16 },
  },
];

// Not captured because they need native macOS UI or real accounts, which the
// isolated demo profile does not have: PR Hub (GitHub connection), account
// Limits meters, SnapShot capture, computer-use approval dialogs, cookie
// import and desktop update prompts.
