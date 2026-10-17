import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerRunProviderUpdateResult,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { createTestRouter, TestRouterContext } from "../../test/routerContext";
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

function card(overrides: Partial<React.ComponentProps<typeof ProviderInstanceCard>> = {}) {
  return (
    <ProviderInstanceCard
      instanceId={CODEX_INSTANCE_ID}
      instance={makeInstance()}
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
      {...overrides}
    />
  );
}
function renderCard(overrides: Partial<React.ComponentProps<typeof ProviderInstanceCard>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createTestRouter();
  return render(card(overrides), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <TestRouterContext router={router}>{children}</TestRouterContext>
      </QueryClientProvider>
    ),
  });
}

describe("ProviderInstanceCard advisory", () => {
  it("defaults Claude native compaction on and persists an explicit opt-out", async () => {
    const onUpdate = vi.fn();
    const screen = await renderCard({
      instance: makeInstance({ driver: ProviderDriverKind.make("claudeAgent") }),
      isExpanded: true,
      onUpdate,
    });
    try {
      const toggle = page.getByRole("switch", {
        name: "Native conversation compaction (applies at next session start)",
      });
      await expect.element(toggle).toBeChecked();
      await toggle.click();
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ config: { nativeCompaction: false } }),
      );
    } finally {
      await screen.unmount();
    }
  });
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

  it("renders the update dialog, copies the display command, and dismisses the latest version", async () => {
    const onDismiss = vi.fn();
    const screen = await renderCard({
      onDismissProviderUpdateAdvisory: onDismiss,
    });

    try {
      await page.getByRole("button", { name: "Update available - view details" }).click();

      expect(document.body.textContent ?? "").toContain("Codex updates");
      expect(document.body.textContent ?? "").toContain("Installed via");

      await vi.waitFor(() => {
        const popup = document.querySelector('[data-slot="dialog-popup"]');
        expect(popup?.textContent ?? "").toContain("npm install -g @openai/codex@latest");
        expect(popup?.getAttribute("class")?.includes("min-w-0")).toBe(true);
      });

      await page.getByRole("button", { name: "Copy update command" }).click();
      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          "npm install -g @openai/codex@latest",
        );
      });

      await page.getByRole("button", { name: "Dismiss notification" }).click();
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

  it("removes normalized duplicate legacy custom models in one action", async () => {
    const onUpdate = vi.fn();
    const screen = await renderCard({
      instance: makeInstance({
        config: {
          customModels: [" custom-model ", "custom-model"],
        },
      }),
      liveProvider: makeLiveProvider({ models: [] }),
      isExpanded: true,
      onUpdate,
    });

    try {
      await page.getByRole("button", { name: "Remove custom-model" }).click();
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            customModels: [],
          },
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("renames a custom model without losing its slug or capabilities", async () => {
    const onUpdate = vi.fn();
    const screen = await renderCard({
      instance: makeInstance({
        config: {
          customModels: [
            { slug: "private/model", name: "Before", capabilities: { optionDescriptors: [] } },
          ],
        },
      }),
      liveProvider: makeLiveProvider({ models: [] }),
      isExpanded: true,
      onUpdate,
    });
    try {
      await page.getByRole("button", { name: "Rename private/model", exact: true }).click();
      await page.getByRole("textbox", { name: "Display name for private/model" }).fill("Reviewer");
      await page.getByRole("button", { name: "Save name", exact: true }).click();
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {
            customModels: [
              { slug: "private/model", name: "Reviewer", capabilities: { optionDescriptors: [] } },
            ],
          },
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
});

const updateResult: ServerRunProviderUpdateResult = {
  instanceId: CODEX_INSTANCE_ID,
  outcome: "failed",
  previousVersion: "0.1.0",
  currentVersion: "0.1.0",
  exitCode: 1,
  timedOut: false,
  output: "installer failure marker",
  outputTruncated: true,
  providers: [],
};
function withAdvisory(
  fields: Partial<NonNullable<ServerProvider["versionAdvisory"]>>,
): ServerProvider {
  return makeLiveProvider({
    versionAdvisory: {
      ...makeLiveProvider().versionAdvisory!,
      installChannel: "npm",
      canRunUpdate: true,
      ...fields,
    },
  });
}

describe("provider update execution", () => {
  it("keeps a known update visible after a failed check without offering an unrunnable update", async () => {
    const check = vi.fn(async () => {});
    const screen = await renderCard({
      liveProvider: withAdvisory({
        status: "check_failed",
        updateAvailable: true,
        canRunUpdate: false,
        message: "Rate limited",
        retryAt: "2026-10-17T18:00:00Z",
      }),
      onCheckProviderUpdates: check,
    });
    try {
      expect(document.body.textContent).toContain("Update check failed");
      await page.getByRole("button", { name: "Update available - view details" }).click();
      expect(document.body.textContent).toContain("Retry after");
      expect(page.getByRole("button", { name: "Update to v0.2.0" }).query()).toBeNull();
      await page.getByRole("button", { name: "Refresh and verify" }).click();
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
  it("runs one explicit update and keeps failure output until dismissed even after the advisory disappears", async () => {
    let complete!: (result: ServerRunProviderUpdateResult) => void;
    const onRun = vi.fn(
      () =>
        new Promise<ServerRunProviderUpdateResult>((resolve) => {
          complete = resolve;
        }),
    );
    const screen = await renderCard({ liveProvider: withAdvisory({}), onRunProviderUpdate: onRun });
    try {
      await page.getByRole("button", { name: "Update available - view details" }).click();
      expect(document.body.textContent).toContain("Close any terminal sessions using this CLI.");
      await page.getByRole("button", { name: "Update to v0.2.0" }).click();
      await expect.element(page.getByText("Updating Codex…", { exact: true })).toBeVisible();
      expect(onRun).toHaveBeenCalledTimes(1);
      complete(updateResult);
      await expect.element(page.getByText("Update failed (exit 1).")).toBeVisible();
      const { versionAdvisory: _advisory, ...withoutAdvisory } = makeLiveProvider();
      await screen.rerender(card({ liveProvider: withoutAdvisory }));
      expect(document.body.textContent).toContain("installer failure marker");
      expect(document.body.textContent).toContain("(earlier output truncated)");
      await page.getByRole("button", { name: "Dismiss update result" }).click();
      expect(document.body.textContent).not.toContain("installer failure marker");
    } finally {
      await screen.unmount();
    }
  });
  it("shows server-owned progress after a remount", async () => {
    const screen = await renderCard({
      liveProvider: withAdvisory({
        activeUpdate: { startedAt: "2026-10-17T00:00:00Z", targetVersion: "0.2.0" },
      }),
    });
    try {
      await expect.element(page.getByText("Updating Codex…", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
  for (const [outcome, message] of [
    ["unchanged", "version is still v0.1.0"],
    ["unexpected_version", "Installed v0.1.0, expected v0.2.0."],
    ["unverified", "F5 couldn't confirm the new version"],
  ] as const)
    it(`explains ${outcome}`, async () => {
      const screen = await renderCard({
        liveProvider: withAdvisory({}),
        onRunProviderUpdate: async () => ({ ...updateResult, outcome }),
      });
      try {
        await page.getByRole("button", { name: "Update available - view details" }).click();
        await page.getByRole("button", { name: "Update to v0.2.0" }).click();
        await vi.waitFor(() => expect(document.body.textContent).toContain(message));
      } finally {
        await screen.unmount();
      }
    });
  it("offers isolated profiles a copy command and Default-profile guidance", async () => {
    const screen = await renderCard({
      liveProvider: withAdvisory({ canRunUpdate: false, blockedReason: "isolated_profile" }),
    });
    try {
      await page.getByRole("button", { name: "Update available - view details" }).click();
      expect(document.body.textContent).toContain("Run provider updates from the Default profile.");
      expect(page.getByRole("button", { name: "Copy update command" }).query()).not.toBeNull();
      expect(page.getByRole("button", { name: "Update to v0.2.0" }).query()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
  it("keeps dismissed updates reachable and supports manual verification", async () => {
    const check = vi.fn(async () => {});
    const screen = await renderCard({
      liveProvider: withAdvisory({
        status: "manual",
        installChannel: "unmanaged",
        canRunUpdate: false,
        updateCommand: null,
        message: "Update using devbox, then verify.",
      }),
      dismissedProviderUpdateAdvisory: "0.2.0",
      onCheckProviderUpdates: check,
    });
    try {
      await page.getByRole("button", { name: "Codex update details" }).click();
      expect(document.body.textContent).toContain("Update using devbox, then verify.");
      await page.getByRole("button", { name: "Refresh and verify" }).click();
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
  it("shows Bundled without an Update notification and links to F5 updates", async () => {
    const screen = await renderCard({
      liveProvider: withAdvisory({
        status: "bundled",
        installChannel: "bundled",
        canRunUpdate: false,
        updateCommand: null,
        message: "Bundled with F5.",
      }),
    });
    try {
      expect(
        page.getByRole("button", { name: "Update available - view details" }).query(),
      ).toBeNull();
      await page.getByRole("button", { name: "Codex update details" }).click();
      await expect.element(page.getByRole("link", { name: "Open F5 updates" })).toBeVisible();
      expect(
        page.getByRole("link", { name: "Open F5 updates" }).element().getAttribute("href"),
      ).toContain("about");
    } finally {
      await screen.unmount();
    }
  });
});

it("opens update details from the keyboard on a narrow screen", async () => {
  await page.viewport(320, 640);
  const screen = await renderCard({
    liveProvider: withAdvisory({
      executablePath: "/a/very/long/provider/installation/prefix/that/should/truncate/bin/codex",
    }),
  });
  try {
    (
      page.getByRole("button", { name: "Update available - view details" }).element() as HTMLElement
    ).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const bounds = page.getByRole("dialog").element().getBoundingClientRect();
    expect(bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
    await page.viewport(1280, 720);
  }
});
it("shows the server's admission error", async () => {
  const screen = await renderCard({
    liveProvider: withAdvisory({}),
    onRunProviderUpdate: async () => {
      throw new Error("Codex has active work.");
    },
  });
  try {
    await page.getByRole("button", { name: "Update available - view details" }).click();
    await page.getByRole("button", { name: "Update to v0.2.0" }).click();
    await expect.element(page.getByText("Codex has active work.")).toBeVisible();
  } finally {
    await screen.unmount();
  }
});

it("keeps server progress visible when the original update RPC disconnects", async () => {
  const screen = await renderCard({
    liveProvider: withAdvisory({}),
    onRunProviderUpdate: async () => {
      throw new Error("Connection lost.");
    },
  });
  try {
    await page.getByRole("button", { name: "Update available - view details" }).click();
    await page.getByRole("button", { name: "Update to v0.2.0" }).click();
    await expect.element(page.getByText("Connection lost.")).toBeVisible();
    await screen.rerender(
      card({
        liveProvider: withAdvisory({
          activeUpdate: { startedAt: "2026-10-17T00:00:00Z", targetVersion: "0.2.0" },
        }),
      }),
    );
    await expect.element(page.getByText("Updating Codex…", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Connection lost.")).toBeVisible();
  } finally {
    await screen.unmount();
  }
});
