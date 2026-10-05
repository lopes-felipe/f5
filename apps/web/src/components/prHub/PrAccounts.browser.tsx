import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PrAccounts } from "./PrAccounts";

const api = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  saveAccount: vi.fn(),
  listAccountRouting: vi.fn(),
  setAccountRouting: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ prHub: api }) }));
const alice = {
  id: "alice",
  provider: "github" as const,
  host: "ghe.example.com",
  login: "alice",
  viewerId: "1",
  generation: "g1",
};
const bob = { ...alice, id: "bob", login: "bob", viewerId: "2" };
beforeEach(() => {
  vi.clearAllMocks();
  api.listAccounts.mockResolvedValue([alice, bob]);
  api.listAccountRouting.mockResolvedValue([]);
  api.saveAccount.mockResolvedValue(alice);
  api.setAccountRouting.mockResolvedValue(undefined);
});

it("selects an exact account or the legacy profile without changing a global account", async () => {
  const onSelect = vi.fn();
  render(<PrAccounts selectedAccountId="alice" onSelect={onSelect} />);
  const selector = page.getByRole("combobox", { name: "Forge account", exact: true });
  await expect.element(selector).toHaveValue("alice");
  await selector.selectOptions("bob");
  expect(onSelect).toHaveBeenLastCalledWith("bob");
  await selector.selectOptions("");
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
  expect(api.saveAccount).not.toHaveBeenCalled();
});

it("verifies credentials on the chosen host and clears the password after success", async () => {
  const onSelect = vi.fn();
  render(<PrAccounts onSelect={onSelect} />);
  await page.getByText("Manage accounts", { exact: true }).click();
  await page.getByRole("textbox", { name: "Host", exact: true }).fill("ghe.example.com");
  const token = page.getByLabelText("Access token", { exact: true });
  await token.fill("sensitive-token");
  await page.getByRole("button", { name: "Verify and save account", exact: true }).click();
  await expect.poll(() => api.saveAccount.mock.calls.length).toBe(1);
  expect(api.saveAccount).toHaveBeenCalledWith({
    provider: "github",
    host: "ghe.example.com",
    token: "sensitive-token",
  });
  await expect.element(token).toHaveValue("");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Verified alice on ghe.example.com.");
  expect(onSelect).toHaveBeenCalledWith("alice");
  expect(document.body.textContent).not.toContain("sensitive-token");
});

it("routes one repository to an exact host/provider/account tuple", async () => {
  api.listAccountRouting
    .mockResolvedValueOnce([])
    .mockResolvedValue([
      { provider: "github", host: "ghe.example.com", repository: "org/repo", accountId: "bob" },
    ]);
  render(<PrAccounts selectedAccountId="alice" onSelect={() => {}} />);
  await page.getByText("Manage accounts", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Account for repository", exact: true })
    .selectOptions("bob");
  await page.getByRole("textbox", { name: "Repository path", exact: true }).fill("org/repo");
  await page.getByRole("button", { name: "Save repository routing", exact: true }).click();
  await expect.poll(() => api.setAccountRouting.mock.calls.length).toBe(1);
  expect(api.setAccountRouting).toHaveBeenCalledWith({
    provider: "github",
    host: "ghe.example.com",
    repository: "org/repo",
    accountId: "bob",
  });
  await expect
    .element(page.getByRole("list", { name: "Repository account routing" }))
    .toHaveTextContent("ghe.example.com/org/repo → bob");
});

it("keeps failed verification visible without echoing a token in its error", async () => {
  api.saveAccount.mockRejectedValue(new Error("sensitive-token"));
  render(<PrAccounts onSelect={() => {}} />);
  await page.getByText("Manage accounts", { exact: true }).click();
  await page.getByLabelText("Access token", { exact: true }).fill("sensitive-token");
  await page.getByRole("button", { name: "Verify and save account", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Could not verify this account.");
  expect(document.body.textContent).not.toContain("sensitive-token");
  await expect
    .element(page.getByRole("button", { name: "Verify and save account", exact: true }))
    .toBeEnabled();
});

it("requires an Azure organization before verifying a scoped token", async () => {
  const azure = { ...alice, id: "azure", provider: "azure-devops" as const, host: "dev.azure.com" };
  api.saveAccount.mockResolvedValue(azure);
  api.listAccounts.mockResolvedValueOnce([alice, bob]).mockResolvedValue([alice, bob, azure]);
  render(<PrAccounts onSelect={() => {}} />);
  await page.getByText("Manage accounts", { exact: true }).click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOptions("azure-devops");
  await page.getByLabelText("Access token", { exact: true }).fill("azure-secret");
  const save = page.getByRole("button", { name: "Verify and save account", exact: true });
  await expect.element(save).toBeDisabled();
  await page.getByRole("textbox", { name: "Organization", exact: true }).fill("my-org");
  await save.click();
  await expect.poll(() => api.saveAccount.mock.calls.length).toBe(1);
  expect(api.saveAccount).toHaveBeenCalledWith({
    provider: "azure-devops",
    host: "dev.azure.com",
    token: "azure-secret",
    organization: "my-org",
  });
  await expect.element(page.getByLabelText("Access token", { exact: true })).toHaveValue("");
});
