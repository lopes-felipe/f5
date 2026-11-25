import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useThemeBackground } from "./themeBackground";

function ThemeBackground({ path }: { path?: string | undefined }) {
  useThemeBackground(path, undefined);
  return null;
}

it("retries a failed download when online and clears the wallpaper when switching themes", async () => {
  const fetch = vi
    .spyOn(window, "fetch")
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(new Response(new Blob(["wallpaper"], { type: "image/png" })))
    .mockRejectedValueOnce(new TypeError("offline again"));
  const property = () =>
    document.documentElement.style.getPropertyValue("--theme-background-image");
  const view = await render(
    <ThemeBackground path="/api/theme-background/test?signature=placeholder" />,
  );
  try {
    expect(property()).toBe("");
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(property()).toContain("blob:"));
    const lastBackground = property();
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(property()).toBe(lastBackground);
    await view.rerender(<ThemeBackground />);
    expect(property()).toBe("");
  } finally {
    await view.unmount();
    fetch.mockRestore();
  }
});
