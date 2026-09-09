import "../../index.css";

import { Schema } from "effect";
import type { NativeApi, ProfileSummary } from "@t3tools/contracts";
import { ProfileId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const { nativeApiRef } = vi.hoisted(() => ({
  nativeApiRef: { current: undefined as NativeApi | undefined },
}));

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => {
    if (!nativeApiRef.current) throw new Error("Native API not found");
    return nativeApiRef.current;
  },
  readNativeApi: () => nativeApiRef.current,
}));

const { ProfilesSettings } = await import("../settings/categories/ProfilesSettings");
const { TooltipProvider } = await import("../ui/tooltip");
const { clearProfilePatches, useProfileState } = await import("../../profileState");

const active: ProfileSummary = {
  id: Schema.decodeUnknownSync(ProfileId)("a".repeat(32)),
  slug: "default",
  name: "Default",
  isDefault: true,
  isActive: true,
  status: "ready",
  port: 3773,
  createdAt: "2026-01-01T00:00:00.000Z",
  stateDir: "C:\\userdata",
  providerAccounts: [],
};

let create: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;

const resetStore = () =>
  useProfileState.setState({
    profiles: [],
    active: null,
    diagnostic: undefined,
    mismatch: false,
    loadState: "idle",
    loadError: null,
    isRefreshing: false,
  });

beforeEach(() => {
  create = vi.fn().mockResolvedValue(active);
  list = vi.fn().mockResolvedValue({ profiles: [active] });
  nativeApiRef.current = {
    profiles: { list, create, update: vi.fn(), remove: vi.fn() },
  } as unknown as NativeApi;
  clearProfilePatches();
  resetStore();
});

afterEach(() => {
  clearProfilePatches();
  resetStore();
});

const mount = () =>
  render(
    <TooltipProvider delay={0}>
      <ProfilesSettings />
    </TooltipProvider>,
  );

describe("load states", () => {
  it("shows skeletons on the first load instead of a blank page", async () => {
    list.mockReturnValue(new Promise(() => {}));
    await mount();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0),
    );
  });

  it("explains when the server has no profiles directory", async () => {
    nativeApiRef.current = {} as NativeApi;
    await mount();
    // Previously refreshProfiles() returned early and left the page blank forever.
    await expect.element(page.getByText("Profiles are unavailable")).toBeVisible();
  });

  it("offers a retry when the list request fails", async () => {
    list.mockRejectedValue(new Error("socket closed"));
    await mount();

    await expect.element(page.getByText("Could not load profiles")).toBeVisible();
    await expect.element(page.getByText("socket closed")).toBeVisible();

    list.mockResolvedValue({ profiles: [active] });
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByRole("heading", { name: "Default" })).toBeVisible();
  });
});

describe("create", () => {
  it("validates before calling the server and previews the slug", async () => {
    await mount();
    await expect.element(page.getByRole("heading", { name: "Default" })).toBeVisible();

    await page.getByRole("button", { name: "New profile" }).click();
    await page.getByRole("button", { name: "Create profile" }).click();

    await expect.element(page.getByText("Name is required.")).toBeVisible();
    expect(create).not.toHaveBeenCalled();

    await page.getByLabelText("Name").fill("My Work");
    await expect.element(page.getByText("t3 --profile my-work")).toBeVisible();

    await page.getByRole("button", { name: "Create profile" }).click();
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "My Work" })),
    );
  });

  it("blocks a duplicate profile name", async () => {
    await mount();
    await expect.element(page.getByRole("heading", { name: "Default" })).toBeVisible();

    await page.getByRole("button", { name: "New profile" }).click();
    await page.getByLabelText("Name").fill("default");
    await page.getByRole("button", { name: "Create profile" }).click();

    await expect.element(page.getByText(/already exists/)).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it("disables mutations while the registry is broken", async () => {
    list.mockResolvedValue({
      profiles: [active],
      diagnostic: { code: "malformed", message: "Bad JSON", path: "C:\\profiles.json" },
    });
    await mount();

    await expect.element(page.getByText("Profile registry unavailable")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "New profile" })).toBeDisabled();
  });
});

describe("accounts", () => {
  it("shows structured status and no raw output until a login runs", async () => {
    list.mockResolvedValue({
      profiles: [
        {
          ...active,
          providerAccounts: [
            {
              driver: "codex",
              instanceId: ProviderInstanceId.make("codex"),
              displayName: "Codex",
              status: "authenticated",
              identity: "user@example.com",
            },
            {
              driver: "claudeAgent",
              instanceId: ProviderInstanceId.make("claude"),
              displayName: "Claude",
              status: "unsupported-isolation",
              reason: "Shares a global config.",
            },
          ],
        },
      ],
    });
    await mount();

    await expect.element(page.getByText("Signed in")).toBeVisible();
    await expect.element(page.getByText("user@example.com")).toBeVisible();
    await expect.element(page.getByText("Not isolated")).toBeVisible();
    await expect.element(page.getByText("Shares a global config.")).toBeVisible();

    // The page used to dump JSON.stringify(accountStatus) inline.
    expect(page.getByLabelText("Account setup output").elements()).toHaveLength(0);
    expect(page.getByLabelText("Account status details").elements()).toHaveLength(0);

    // An authenticated account offers Sign out, not Sign in, and the driver
    // that cannot be isolated gets no account controls at all.
    expect(page.getByRole("button", { name: "Sign out" }).elements()).toHaveLength(1);
    expect(page.getByRole("button", { name: "Sign in" }).elements()).toHaveLength(0);
  });
});
