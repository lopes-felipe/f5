import "../../index.css";

import { Schema } from "effect";
import type { NativeApi } from "@t3tools/contracts";
import { ProfileId, type ProfileSummary } from "@t3tools/contracts";
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

const { TooltipProvider } = await import("../ui/tooltip");
const { ProfileCard } = await import("./ProfileCard");
const { clearProfilePatches, useProfileState } = await import("../../profileState");

const work: ProfileSummary = {
  id: Schema.decodeUnknownSync(ProfileId)("b".repeat(32)),
  slug: "work",
  name: "Work",
  isDefault: false,
  isActive: false,
  status: "ready",
  port: 3774,
  accentColor: "#2563eb",
  createdAt: "2026-01-01T00:00:00.000Z",
  stateDir: "C:\\profiles\\work",
  providerAccounts: [],
};

const originalBridge = window.desktopBridge;
let listResult: { profiles: readonly ProfileSummary[] };
let update: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listResult = { profiles: [work] };
  update = vi.fn().mockResolvedValue(work);
  remove = vi.fn().mockResolvedValue(undefined);
  nativeApiRef.current = {
    profiles: {
      list: () => Promise.resolve(listResult),
      update,
      remove,
      create: vi.fn(),
    },
  } as unknown as NativeApi;
  delete window.desktopBridge;
  clearProfilePatches();
  useProfileState.setState({ profiles: [work], active: null, diagnostic: undefined });
});

afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  clearProfilePatches();
  useProfileState.setState({ profiles: [], active: null, diagnostic: undefined });
});

function mount(profile: ProfileSummary = work, onRequestRemove = vi.fn()) {
  return render(
    <TooltipProvider delay={0}>
      <ProfileCard
        profile={profile}
        profiles={[profile]}
        disabled={false}
        onRequestRemove={onRequestRemove}
      />
    </TooltipProvider>,
  );
}

const expandEditor = async (profile: ProfileSummary = work) => {
  await page.getByRole("button", { name: `Edit ${profile.name}` }).click();
};

describe("identity", () => {
  it("shows the slug, port and state directory instead of a status slug line", async () => {
    await mount();
    await expect.element(page.getByRole("heading", { name: "Work" })).toBeVisible();
    await expect.element(page.getByText("work", { exact: true })).toBeVisible();
    await expect.element(page.getByText("localhost:3774")).toBeVisible();
    await expect.element(page.getByText("C:\\profiles\\work")).toBeVisible();
    // The old card rendered "work / ready / port 3774" as one raw string.
    expect(page.getByText("/ ready / port").elements()).toHaveLength(0);
  });

  it("badges a profile that is still provisioning and blocks editing", async () => {
    await mount({ ...work, status: "provisioning" });
    await expect.element(page.getByText("Setting up")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Edit Work" })).toBeDisabled();
  });

  it("renders server warnings as alerts rather than bare amber text", async () => {
    await mount({
      ...work,
      invalidDirectories: [{ directory: "C:\\gone", reason: "Missing." }],
      sharedRepositories: [{ workspaceRoot: "C:\\repo", otherProfiles: ["Personal"] }],
    });
    await expect.element(page.getByText("Project folder is unavailable")).toBeVisible();
    await expect.element(page.getByText("Shared Git checkout")).toBeVisible();
  });
});

describe("renaming", () => {
  it("commits on blur and survives a stale server snapshot", async () => {
    await mount();
    await expandEditor();

    const nameField = page.getByLabelText("Name");
    await nameField.fill("Renamed");
    await page.getByRole("heading", { name: "Work" }).click(); // blur

    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed" })),
    );

    // The server caches profile reads for 2s, so the refresh that follows a
    // successful write can legitimately replay the pre-edit value.
    useProfileState.setState({ profiles: [work] });

    await expect.element(page.getByLabelText("Name")).toHaveValue("Renamed");
  });
});

describe("port", () => {
  it("does not commit until Apply is pressed", async () => {
    await mount();
    await expandEditor();

    await page.getByLabelText("Port").fill("3999");
    expect(update).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Apply" }).click();
    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ port: 3999 })),
    );
    // Sent as a number, not the raw input string.
    expect(update.mock.calls[0]![0].port).toBeTypeOf("number");
  });

  it("rejects an out-of-range port inline and keeps Apply disabled", async () => {
    await mount();
    await expandEditor();

    await page.getByLabelText("Port").fill("70000");

    await expect.element(page.getByText("Port must be between 1 and 65535.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it("surfaces the server's rejection and keeps the draft", async () => {
    update.mockRejectedValue(new Error("That port is owned, retired, or already in use."));
    await mount();
    await expandEditor();

    await page.getByLabelText("Port").fill("3999");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect
      .element(page.getByText("That port is owned, retired, or already in use."))
      .toBeVisible();
    await expect.element(page.getByLabelText("Port")).toHaveValue("3999");
  });

  it("reverts to the server value on Reset", async () => {
    await mount();
    await expandEditor();

    await page.getByLabelText("Port").fill("3999");
    await page.getByRole("button", { name: "Reset" }).click();

    await expect.element(page.getByLabelText("Port")).toHaveValue("3774");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("launch command", () => {
  it("copies the command and confirms it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await mount();
    await page.getByRole("button", { name: "Copy launch command for Work" }).click();

    expect(writeText).toHaveBeenCalledWith("t3 --profile work");

    // The old button wrote to the clipboard and gave no feedback at all. The
    // copy icon now swaps to a checkmark (and the tooltip label follows).
    await vi.waitFor(() => {
      const icon = page
        .getByRole("button", { name: "Copy launch command for Work" })
        .element()
        .querySelector("svg");
      expect(icon?.getAttribute("class") ?? "").toContain("check");
    });
  });
});

describe("removal", () => {
  it("asks the parent to confirm rather than deleting inline", async () => {
    const onRequestRemove = vi.fn();
    await mount(work, onRequestRemove);
    await expandEditor();

    await page.getByRole("button", { name: "Remove profile" }).click();

    expect(onRequestRemove).toHaveBeenCalledWith(work);
    expect(remove).not.toHaveBeenCalled();
  });

  it("blocks removal of the default profile and explains why", async () => {
    await mount({ ...work, isDefault: true, name: "Default" });
    await expandEditor({ ...work, name: "Default" });

    await expect.element(page.getByRole("button", { name: "Remove profile" })).toBeDisabled();
    await expect.element(page.getByText("The default profile cannot be removed.")).toBeVisible();
  });

  it("blocks removal of the active profile, which would deadlock on its own lock", async () => {
    await mount({ ...work, isActive: true });
    await expandEditor();

    await expect.element(page.getByRole("button", { name: "Remove profile" })).toBeDisabled();
    await expect
      .element(page.getByText("Switch to another profile before removing this one."))
      .toBeVisible();
  });
});
