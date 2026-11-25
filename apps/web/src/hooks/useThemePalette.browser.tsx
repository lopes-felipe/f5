import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { readAppSettingsSnapshot, updateAppSettings } from "../appSettings";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { useThemePaletteSync } from "./useThemePalette";

function ThemeSync() {
  useThemePaletteSync("dark");
  return null;
}

it("adopts each environment selection once and keeps a later local choice", async () => {
  const client = new QueryClient();
  const key = "f5:applied-environment-theme";
  const previousGeneration = localStorage.getItem(key);
  const previousTheme = readAppSettingsSnapshot().themeId;
  const publish = (value: string, generation: string) =>
    client.setQueryData(serverQueryKeys.config(), {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        environmentThemeSelection: { theme: { value, generation } },
      },
    });
  localStorage.removeItem(key);
  publish("f5-grove", "first");
  const view = await render(
    <QueryClientProvider client={client}>
      <ThemeSync />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(readAppSettingsSnapshot().themeId).toBe("f5-grove"));
    updateAppSettings({ themeId: "f5-ember" });
    await view.rerender(
      <QueryClientProvider client={client}>
        <ThemeSync />
      </QueryClientProvider>,
    );
    expect(readAppSettingsSnapshot().themeId).toBe("f5-ember");
    publish("f5-iris", "second");
    await vi.waitFor(() => expect(readAppSettingsSnapshot().themeId).toBe("f5-iris"));
  } finally {
    await view.unmount();
    client.clear();
    updateAppSettings({ themeId: previousTheme });
    if (previousGeneration === null) localStorage.removeItem(key);
    else localStorage.setItem(key, previousGeneration);
  }
});
