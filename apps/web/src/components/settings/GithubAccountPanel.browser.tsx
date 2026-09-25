import "../../index.css";
import type { GithubLoginStatus, NativeApi } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { GithubAccountPanel } from "./GithubAccountPanel";

const ref = vi.hoisted(() => ({ current: undefined as NativeApi | undefined }));
const settingsStore = vi.hoisted(() => {
  let value = { gitAuthorName: "", gitAuthorEmail: "" };
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: typeof value) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateSettings: undefined as unknown as ReturnType<typeof vi.fn>,
  };
});
vi.mock("../../nativeApi", () => ({ readNativeApi: () => ref.current }));
vi.mock("../../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSettings: (selector?: (settings: unknown) => unknown) => {
      const value = useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
      return selector ? selector(value) : value;
    },
    useUpdateSettings: () => ({ updateSettings: settingsStore.updateSettings }),
  };
});

let status: GithubLoginStatus;
let api: NonNullable<NativeApi["profiles"]>;
let openExternal: ReturnType<typeof vi.fn>;
beforeEach(() => {
  settingsStore.set({ gitAuthorName: "", gitAuthorEmail: "" });
  settingsStore.updateSettings = vi.fn(async () => {});
  status = { available: true, state: "idle" };
  openExternal = vi.fn(async () => {});
  // Accounts imported from GitHub CLI are reported by later status checks, like the server.
  const imported = new Map<string, string>();
  api = {
    githubStatus: vi.fn(async ({ host }: { host: string }) => ({
      login: imported.get(host) ?? null,
    })),
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
      status = { available: true, state: "cancelled", handle: "attempt" };
    }),
    githubSet: vi.fn(async () => ({ login: "personal-user" })),
    githubRemove: vi.fn(async () => {}),
    githubCliCandidates: vi.fn(async () => ({
      ghAvailable: true,
      accounts: [
        {
          host: "ghe.example.com",
          login: "alice_corp",
          active: true,
          tokenSource: "oauth_token",
          scopes: ["repo", "read:org", "notifications"],
          missingScopes: [],
        },
        {
          host: "github.com",
          login: "octocat",
          active: true,
          tokenSource: "keyring",
          scopes: ["repo", "read:org", "gist"],
          missingScopes: ["notifications"],
        },
      ],
    })),
    githubCliImport: vi.fn(async (input: { host: string; login: string }) => {
      imported.set(input.host, input.login);
      return {
        login: input.login,
        missingScopes: input.login === "octocat" ? ["notifications"] : [],
      };
    }),
  } as unknown as NonNullable<NativeApi["profiles"]>;
  ref.current = { profiles: api, shell: { openExternal } } as unknown as NativeApi;
});

const statusLine = (text: string) => page.getByRole("status").filter({ hasText: text });

it("shows a device code, opens GitHub and cancels the originating attempt", async () => {
  await render(<GithubAccountPanel />);
  await expect.element(page.getByText("Not connected", { exact: true }).first()).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect.element(page.getByText("ABCD-EFGH")).toBeVisible();
  await expect.element(page.getByText("Signing in", { exact: true })).toBeVisible();
  expect(api.githubLoginStart).toHaveBeenCalledWith();
  expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device");
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  expect(api.githubLoginCancel).toHaveBeenCalledWith({ handle: "attempt" });
  await expect.element(page.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
  await expect.element(page.getByText("ABCD-EFGH")).not.toBeInTheDocument();
});

it("keeps browser sign-in to github.com and uses the token form for Enterprise hosts", async () => {
  await render(<GithubAccountPanel />);
  await page.getByLabelText("GitHub or GitHub Enterprise hostname").fill("ghe.example.com");
  await expect.element(statusLine("ghe.example.com: Not connected")).toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Sign in with GitHub" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText(/Browser sign-in is available for github.com/)).toBeVisible();
  await page.getByLabelText("GitHub token", { exact: true }).fill("enterprise-token");
  await page.getByRole("button", { name: "Verify and save token" }).click();
  expect(api.githubSet).toHaveBeenCalledWith({
    host: "ghe.example.com",
    token: "enterprise-token",
  });
  expect(api.githubLoginStart).not.toHaveBeenCalled();
});

it("falls back to the token form when browser sign-in is disabled and clears the token", async () => {
  status = { available: false, state: "idle" };
  await render(<GithubAccountPanel />);
  await expect.element(page.getByText(/disabled for this installation/)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Sign in with GitHub" }))
    .not.toBeInTheDocument();
  // The token form starts open when browser sign-in can't be used.
  await page.getByLabelText("GitHub token", { exact: true }).fill("private-token");
  await page.getByRole("button", { name: "Verify and save token" }).click();
  expect(api.githubSet).toHaveBeenCalledWith({ host: "github.com", token: "private-token" });
  await expect.element(statusLine("github.com: personal-user")).toBeInTheDocument();
  await expect.element(page.getByText("@personal-user")).toBeVisible();
  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect.element(page.getByLabelText("GitHub token", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  expect(api.githubRemove).toHaveBeenCalledWith({ host: "github.com" });
  await expect.element(statusLine("github.com: Not connected")).toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Disconnect", exact: true }))
    .not.toBeInTheDocument();
});

it("shows server errors without transport prefixes and keeps the token on failure", async () => {
  class WsRequestError extends Error {
    override name = "WsRequestError";
  }
  vi.mocked(api.githubSet).mockRejectedValueOnce(
    new WsRequestError("GitHub account verification failed (401)."),
  );
  await render(<GithubAccountPanel />);
  await page.getByRole("button", { name: "Use a personal access token" }).click();
  await page.getByLabelText("GitHub token", { exact: true }).fill("bad-token");
  await page.getByRole("button", { name: "Verify and save token" }).click();
  await expect
    .element(page.getByText("GitHub account verification failed (401).", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByText(/WsRequestError/)).not.toBeInTheDocument();
  await expect
    .element(page.getByLabelText("GitHub token", { exact: true }))
    .toHaveValue("bad-token");
});

it("normalizes pasted hosts, rejects invalid ones, and debounces checks", async () => {
  vi.mocked(api.githubStatus).mockRejectedValueOnce(new Error("offline"));
  await render(<GithubAccountPanel />);
  await expect.element(page.getByText(/Unable to verify this GitHub connection/)).toBeVisible();
  const field = page.getByLabelText("GitHub or GitHub Enterprise hostname");
  await field.fill("bad..");
  await expect.element(page.getByText("Invalid host")).toBeVisible();
  await expect
    .element(page.getByText(/Unable to verify this GitHub connection/))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Sign in with GitHub" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Check account" })).toBeDisabled();
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(api.githubStatus).toHaveBeenCalledTimes(1);
  await field.fill("git.example.com");
  await field.fill(" https://Enterprise.Example.com/ ");
  await expect.element(statusLine("enterprise.example.com: Not connected")).toBeInTheDocument();
  expect(api.githubStatus).toHaveBeenCalledTimes(2);
  expect(api.githubStatus).toHaveBeenLastCalledWith({ host: "enterprise.example.com" });
});

it("does not claim browser sign-in is disabled before the server answers", async () => {
  vi.mocked(api.githubLoginStatus).mockImplementation(() => new Promise(() => {}));
  await render(<GithubAccountPanel />);
  await expect.element(page.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
  await expect.element(page.getByText(/disabled for this installation/)).not.toBeInTheDocument();
});

it("polls only during a pending sign-in and stops on completion", async () => {
  await render(<GithubAccountPanel />);
  await expect.element(page.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
  await new Promise((resolve) => setTimeout(resolve, 1650));
  expect(api.githubLoginStatus).toHaveBeenCalledTimes(1);
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  status = { available: true, state: "connected", handle: "attempt", login: "browser-user" };
  await expect.element(statusLine("github.com: browser-user")).toBeInTheDocument();
  expect(api.githubLoginStatus).toHaveBeenLastCalledWith({ handle: "attempt" });
  const calls = vi.mocked(api.githubLoginStatus).mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 1650));
  expect(api.githubLoginStatus).toHaveBeenCalledTimes(calls);
});

it("adopts late-loading author settings and saves only real changes", async () => {
  await render(<GithubAccountPanel />);
  const save = page.getByRole("button", { name: "Save Git author" });
  await expect.element(save).toBeDisabled();
  settingsStore.set({ gitAuthorName: "Saved Name", gitAuthorEmail: "saved@example.com" });
  await expect.element(page.getByLabelText("Git author name")).toHaveValue("Saved Name");
  await expect.element(page.getByLabelText("Git author email")).toHaveValue("saved@example.com");
  await expect.element(save).toBeDisabled();
  await page.getByLabelText("Git author name").fill("New Name");
  await expect.element(save).toBeEnabled();
  await page.getByLabelText("Git author email").fill("");
  await expect.element(save).toBeDisabled();
  await expect.element(page.getByText(/Enter both a name and an email/)).toBeVisible();
  await page.getByLabelText("Git author email").fill("new@example.com");
  await save.click();
  expect(settingsStore.updateSettings).toHaveBeenCalledWith({
    gitAuthorName: "New Name",
    gitAuthorEmail: "new@example.com",
  });
});

it("keeps an in-flight account check when saving the Git author", async () => {
  let finish!: (value: { login: string | null }) => void;
  vi.mocked(api.githubStatus).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render(<GithubAccountPanel />);
  await expect.element(page.getByText("Checking…")).toBeVisible();
  await expect.poll(() => vi.mocked(api.githubStatus).mock.calls.length).toBe(1);
  await page.getByLabelText("Git author name").fill("Name");
  await page.getByLabelText("Git author email").fill("name@example.com");
  await page.getByRole("button", { name: "Save Git author" }).click();
  expect(settingsStore.updateSettings).toHaveBeenCalled();
  finish({ login: "still-checked" });
  await expect.element(statusLine("github.com: still-checked")).toBeInTheDocument();
});

it("lists GitHub CLI logins on demand and imports the chosen account", async () => {
  await render(<GithubAccountPanel />);
  await expect.element(statusLine("github.com: Not connected")).toBeInTheDocument();
  // Discovery is on demand only (gh auth status makes network calls on the backend).
  expect(api.githubCliCandidates).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Use GitHub CLI login" }).click();
  const logins = page.getByRole("group", { name: "GitHub CLI logins" });
  await expect.element(logins.getByText("@octocat")).toBeVisible();
  await expect.element(logins.getByText("@alice_corp")).toBeVisible();
  await expect.element(logins.getByText("No notifications scope")).toBeVisible();
  // The selected host's accounts are listed first.
  await expect.element(logins.getByRole("listitem").first()).toHaveTextContent(/@octocat/);
  await page.getByRole("button", { name: "Import @octocat on github.com" }).click();
  expect(api.githubCliImport).toHaveBeenCalledWith({ host: "github.com", login: "octocat" });
  await expect.element(statusLine("github.com: octocat")).toBeInTheDocument();
  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect.element(logins).not.toBeInTheDocument();
  await expect
    .element(page.getByText(/gh auth refresh -h github.com -s notifications/))
    .toBeVisible();
});

it("imports an Enterprise account and switches the card to that host", async () => {
  await render(<GithubAccountPanel />);
  await page.getByRole("button", { name: "Use GitHub CLI login" }).click();
  await page.getByRole("button", { name: "Import @alice_corp on ghe.example.com" }).click();
  expect(api.githubCliImport).toHaveBeenCalledWith({
    host: "ghe.example.com",
    login: "alice_corp",
  });
  await expect
    .element(page.getByLabelText("GitHub or GitHub Enterprise hostname"))
    .toHaveValue("ghe.example.com");
  await expect.element(page.getByText("@alice_corp")).toBeVisible();
});

it("explains when gh is missing or has no login", async () => {
  vi.mocked(api.githubCliCandidates).mockResolvedValueOnce({ ghAvailable: false, accounts: [] });
  await render(<GithubAccountPanel />);
  await page.getByRole("button", { name: "Use GitHub CLI login" }).click();
  await expect.element(page.getByText(/GitHub CLI isn't installed/)).toBeVisible();
  // Clicking again closes the panel; reopening checks again.
  await page.getByRole("button", { name: "Use GitHub CLI login" }).click();
  vi.mocked(api.githubCliCandidates).mockResolvedValueOnce({ ghAvailable: true, accounts: [] });
  await page.getByRole("button", { name: "Use GitHub CLI login" }).click();
  await expect.element(page.getByText(/No GitHub CLI login found/)).toBeVisible();
});

it("shows import errors without transport prefixes", async () => {
  class WsRequestError extends Error {
    override name = "WsRequestError";
  }
  vi.mocked(api.githubCliImport).mockRejectedValueOnce(
    new WsRequestError("The GitHub CLI token belongs to a different account."),
  );
  await render(<GithubAccountPanel />);
  await page.getByRole("button", { name: "Use GitHub CLI login" }).click();
  await page.getByRole("button", { name: "Import @octocat on github.com" }).click();
  await expect
    .element(
      page.getByText("The GitHub CLI token belongs to a different account.", { exact: true }),
    )
    .toBeVisible();
  await expect.element(page.getByText(/WsRequestError/)).not.toBeInTheDocument();
  await expect.element(statusLine("github.com: Not connected")).toBeInTheDocument();
});
