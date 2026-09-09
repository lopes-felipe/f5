import { Schema } from "effect";
import "../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { ProfileId, type ProfileSummary } from "@t3tools/contracts";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { profileBrowserUrl, useProfileState } from "../profileState";

const active: ProfileSummary = {
  id: Schema.decodeUnknownSync(ProfileId)("a".repeat(32)),
  slug: "default",
  name: "Default",
  isDefault: true,
  isActive: true,
  status: "ready",
  port: 3773,
  createdAt: "2026-01-01T00:00:00.000Z",
  stateDir: "/state",
  providerAccounts: [],
};
const work: ProfileSummary = {
  ...active,
  id: Schema.decodeUnknownSync(ProfileId)("b".repeat(32)),
  slug: "work",
  name: "Work",
  isDefault: false,
  isActive: false,
  port: 3774,
};
const originalBridge = window.desktopBridge;
afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  useProfileState.setState({ active: null, profiles: [], mismatch: false });
});
async function mount(profiles: readonly ProfileSummary[] = [active, work]) {
  useProfileState.setState({ active, profiles, mismatch: false });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: ProfileSwitcher }),
  });
  await render(<RouterProvider router={router} />);
  await page.getByRole("button", { name: "Switch profile" }).click();
}

it("opens browser profiles on the current host with their own port", async () => {
  delete window.desktopBridge;
  await mount();
  await expect.element(page.getByLabelText("Active profile")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Open Work" }))
    .toHaveAttribute("href", profileBrowserUrl(work));
  expect(profileBrowserUrl(work, { protocol: "https:", hostname: "remote.example" })).toBe(
    "https://remote.example:3774/",
  );
  expect(profileBrowserUrl(work, { protocol: "http:", hostname: "::1" })).toBe(
    "http://[::1]:3774/",
  );
});

it("asks desktop to open the selected profile by immutable id", async () => {
  const switchProfile = vi.fn().mockResolvedValue(undefined);
  window.desktopBridge = { ...originalBridge, switchProfile } as NonNullable<
    typeof window.desktopBridge
  >;
  await mount();
  await page.getByRole("button", { name: "Open Work" }).click();
  expect(switchProfile).toHaveBeenCalledWith(work.id);
});

it("surfaces profiles that are not ready instead of hiding them", async () => {
  delete window.desktopBridge;
  const provisioning: ProfileSummary = { ...work, status: "provisioning", name: "Staging" };
  await mount([active, provisioning]);

  // The old switcher filtered these out entirely, so a profile mid-setup
  // simply vanished from the list with no explanation.
  await expect.element(page.getByText("Staging")).toBeVisible();
  await expect.element(page.getByText("Setting up")).toBeVisible();
  expect(page.getByRole("link", { name: "Open Staging" }).elements()).toHaveLength(0);
});
