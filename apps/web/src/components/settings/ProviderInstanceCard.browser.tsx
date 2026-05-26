import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS } from "./providerDriverMeta";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CODEX_DRIVER_OPTION = DRIVER_OPTIONS.find((option) => option.value === CODEX_DRIVER);

const noop = () => {};

function makeInstance(overrides: Partial<ProviderInstanceConfig> = {}): ProviderInstanceConfig {
  return {
    driver: CODEX_DRIVER,
    enabled: true,
    ...overrides,
  };
}

function makeLiveProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: CODEX_INSTANCE_ID,
    driver: CODEX_DRIVER,
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: {
      status: "unknown",
    },
    checkedAt: "2026-05-26T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateCommand: {
        executable: "npm",
        args: ["install", "-g", "@openai/codex@latest"],
        channel: "npm",
      },
      checkedAt: "2026-05-26T00:00:00.000Z",
      message: "Installed v0.1.0 · latest v0.2.0",
    },
    ...overrides,
  };
}

function renderCard(
  overrides: {
    readonly instance?: ProviderInstanceConfig;
    readonly liveProvider?: ServerProvider;
    readonly dismissedProviderUpdateAdvisory?: string;
    readonly onDismissProviderUpdateAdvisory?: (latestVersion: string) => void;
  } = {},
) {
  return render(
    <ProviderInstanceCard
      instanceId={CODEX_INSTANCE_ID}
      instance={overrides.instance ?? makeInstance()}
      driverOption={CODEX_DRIVER_OPTION}
      liveProvider={overrides.liveProvider ?? makeLiveProvider()}
      isExpanded={false}
      onExpandedChange={noop}
      onUpdate={noop}
      dismissedProviderUpdateAdvisory={overrides.dismissedProviderUpdateAdvisory}
      onDismissProviderUpdateAdvisory={overrides.onDismissProviderUpdateAdvisory}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onHiddenModelsChange={noop}
      onFavoriteModelsChange={noop}
      onModelOrderChange={noop}
    />,
  );
}

describe("ProviderInstanceCard advisory", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders the update popover, copies the display command, and dismisses the latest version", async () => {
    const onDismiss = vi.fn();
    const screen = await renderCard({
      onDismissProviderUpdateAdvisory: onDismiss,
    });

    try {
      await page.getByRole("button", { name: "Update available - view details" }).click();

      expect(document.body.textContent ?? "").toContain("Update available");
      expect(document.body.textContent ?? "").toContain("npm install command");

      await vi.waitFor(() => {
        const popup = document.querySelector('[data-slot="popover-popup"]');
        expect(popup?.textContent ?? "").toContain("npm install -g @openai/codex@latest");
        expect(popup?.getAttribute("class")?.includes("calc(100vw-1.5rem)")).toBe(true);
      });

      await page.getByRole("button", { name: "Copy update command" }).click();
      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          "npm install -g @openai/codex@latest",
        );
      });

      await page.getByRole("button", { name: "Dismiss" }).click();
      expect(onDismiss).toHaveBeenCalledWith("0.2.0");
    } finally {
      await screen.unmount();
    }
  });

  it("hides the update affordance unless an enabled provider is behind an undismissed latest version", async () => {
    const screen = await renderCard({
      liveProvider: makeLiveProvider({
        versionAdvisory: {
          status: "current",
          currentVersion: "0.2.0",
          latestVersion: "0.2.0",
          updateCommand: null,
          checkedAt: "2026-05-26T00:00:00.000Z",
          message: "Current",
        },
      }),
    });

    try {
      expect(
        page.getByRole("button", { name: "Update available - view details" }).query(),
      ).toBeNull();

      await screen.rerender(
        <ProviderInstanceCard
          instanceId={CODEX_INSTANCE_ID}
          instance={makeInstance({ enabled: false })}
          driverOption={CODEX_DRIVER_OPTION}
          liveProvider={makeLiveProvider()}
          isExpanded={false}
          onExpandedChange={noop}
          onUpdate={noop}
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onHiddenModelsChange={noop}
          onFavoriteModelsChange={noop}
          onModelOrderChange={noop}
        />,
      );
      expect(
        page.getByRole("button", { name: "Update available - view details" }).query(),
      ).toBeNull();

      await screen.rerender(
        <ProviderInstanceCard
          instanceId={CODEX_INSTANCE_ID}
          instance={makeInstance()}
          driverOption={CODEX_DRIVER_OPTION}
          liveProvider={makeLiveProvider()}
          isExpanded={false}
          onExpandedChange={noop}
          onUpdate={noop}
          dismissedProviderUpdateAdvisory="0.2.0"
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onHiddenModelsChange={noop}
          onFavoriteModelsChange={noop}
          onModelOrderChange={noop}
        />,
      );
      expect(
        page.getByRole("button", { name: "Update available - view details" }).query(),
      ).toBeNull();

      await screen.rerender(
        <ProviderInstanceCard
          instanceId={CODEX_INSTANCE_ID}
          instance={makeInstance()}
          driverOption={CODEX_DRIVER_OPTION}
          liveProvider={makeLiveProvider({
            versionAdvisory: {
              ...makeLiveProvider().versionAdvisory!,
              latestVersion: "0.3.0",
              message: "Installed v0.1.0 · latest v0.3.0",
            },
          })}
          isExpanded={false}
          onExpandedChange={noop}
          onUpdate={noop}
          dismissedProviderUpdateAdvisory="0.2.0"
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onHiddenModelsChange={noop}
          onFavoriteModelsChange={noop}
          onModelOrderChange={noop}
        />,
      );

      expect(
        page.getByRole("button", { name: "Update available - view details" }).query(),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
