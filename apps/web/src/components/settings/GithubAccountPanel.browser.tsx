import "../../index.css";
import type { GithubLoginStatus, NativeApi } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { GithubAccountPanel } from "./GithubAccountPanel";

const ref = vi.hoisted(() => ({ current: undefined as NativeApi | undefined }));
vi.mock("../../nativeApi", () => ({ readNativeApi: () => ref.current }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ gitAuthorName: "", gitAuthorEmail: "" }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
let status: GithubLoginStatus;
let api: NonNullable<NativeApi["profiles"]>;
let openExternal: ReturnType<typeof vi.fn>;
beforeEach(() => {
  status = { available: true, state: "idle" };
  openExternal = vi.fn(async () => {});
  api = {
    githubStatus: vi.fn(async () => ({ login: null })),
    githubLoginStatus: vi.fn(async () => status),
    githubLoginStart: vi.fn(async () => {
      status = {
        available: true,
        state: "pending",
        handle: "attempt",
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
      };
      return status;
    }),
    githubLoginCancel: vi.fn(async () => {
      status = { available: true, state: "cancelled" };
    }),
    githubSet: vi.fn(async () => ({ login: "personal-user" })),
    githubRemove: vi.fn(async () => {}),
  } as unknown as NonNullable<NativeApi["profiles"]>;
  ref.current = { profiles: api, shell: { openExternal } } as unknown as NativeApi;
});

it("shows a device code, opens GitHub and cancels the originating attempt", async () => {
  await render(<GithubAccountPanel />);
  await expect.element(page.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect.element(page.getByText("ABCD-EFGH")).toBeVisible();
  expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device");
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  expect(api.githubLoginCancel).toHaveBeenCalledWith({ handle: "attempt" });
  await expect.element(page.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
});

it("keeps token login available without OAuth configuration and clears the submitted token", async () => {
  status = { available: false, state: "idle" };
  await render(<GithubAccountPanel />);
  await expect.element(page.getByText(/Browser sign-in is not configured/)).toBeVisible();
  await page.getByLabelText("GitHub token", { exact: true }).fill("private-token");
  await page.getByRole("button", { name: "Verify and save token" }).click();
  expect(api.githubSet).toHaveBeenCalledWith({ host: "github.com", token: "private-token" });
  await expect.element(page.getByText("github.com: personal-user")).toBeVisible();
  await expect.element(page.getByLabelText("GitHub token", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  expect(api.githubRemove).toHaveBeenCalledWith({ host: "github.com" });
  await expect.element(page.getByText("github.com: Not connected")).toBeVisible();
});
