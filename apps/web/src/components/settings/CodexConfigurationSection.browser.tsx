import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { CodexConfigurationSection } from "./CodexConfigurationSection";

const mock = vi.hoisted(() => ({ request: vi.fn(), refresh: vi.fn(async () => ({})) }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    server: { codexConfiguration: mock.request, refreshProviders: mock.refresh },
  }),
}));
beforeEach(() => {
  mock.request.mockReset();
  mock.request.mockResolvedValue({
    providers: {
      data: [
        {
          id: "team",
          name: "Team",
          canEdit: true,
          baseUrl: null,
          settings: { type: "customGateway", auth: { mode: "externallyConfigured", envKey: null } },
        },
      ],
      defaultProviderId: "team",
      canChangeDefault: false,
    },
    features: { audio: false, animation: false },
    securityNotice: null,
  });
});
afterEach(() => {
  document.body.innerHTML = "";
});

it("keeps login A polled and cancellable while checking gateway B", async () => {
  const configuration = await mock.request.getMockImplementation()!();
  const team = configuration.providers.data[0];
  configuration.providers.data.push({ ...team, id: "other", name: "Other" });
  let loggedIn = false;
  mock.request.mockImplementation(async ({ action }) => {
    if (action.type === "read") return configuration;
    if (action.type === "gatewayCancel") {
      loggedIn = false;
      return {};
    }
    if (!action.providerId) throw new Error("Missing provider ID");
    const gateway = {
      providerId: action.providerId,
      providerName: action.providerId === "team" ? "Team" : "Other",
      required: true,
      supportsDeviceAuth: true,
      status: "notReady",
      error: null,
    };
    if (action.type === "gatewayLogin") loggedIn = true;
    return {
      gateway,
      ...(loggedIn && action.providerId === "team"
        ? {
            login: {
              loginId: "login-a",
              providerId: "team",
              status: "started",
              authUrl: "https://example.test/login",
              verificationUrl: null,
              userCode: null,
              error: null,
            },
          }
        : {}),
    };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <CodexConfigurationSection
        instanceId={ProviderInstanceId.make("codex")}
        accountIdentity="oauth"
        onSelectProvider={() => undefined}
      />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole("button", { name: "Codex model providers", exact: true }).click();
    await page.getByRole("button", { name: "Check Team sign-in" }).click();
    await page.getByRole("button", { name: "Sign in to gateway", exact: true }).click();
    await page.getByRole("button", { name: "Check Other sign-in" }).click();
    await expect.element(page.getByRole("button", { name: "Cancel gateway login" })).toBeVisible();
    const teamReads = () =>
      mock.request.mock.calls.filter(
        ([input]) => input.action.type === "gatewayRead" && input.action.providerId === "team",
      ).length;
    const before = teamReads();
    await expect.poll(teamReads, { timeout: 4000 }).toBeGreaterThan(before);
    expect(
      mock.request.mock.calls.every(
        ([input]) =>
          !["gatewayRead", "gatewayLogin"].includes(input.action.type) || !!input.action.providerId,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Cancel gateway login" }).click();
    expect(
      mock.request.mock.calls.some(
        ([input]) => input.action.type === "gatewayCancel" && input.action.loginId === "login-a",
      ),
    ).toBe(true);
    await expect
      .element(page.getByRole("button", { name: "Cancel gateway login" }))
      .not.toBeInTheDocument();
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("allows resetting an unavailable saved provider when configuration fails", async () => {
  mock.request.mockRejectedValue(new Error("Provider unavailable"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const select = vi.fn();
  const screen = await render(
    <QueryClientProvider client={client}>
      <CodexConfigurationSection
        instanceId={ProviderInstanceId.make("codex")}
        accountIdentity="unavailable"
        selectedProvider="removed"
        onSelectProvider={select}
      />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole("button", { name: "Codex model providers", exact: true }).click();
    await page.getByRole("combobox", { name: /Provider for new conversations/ }).selectOptions("");
    expect(select).toHaveBeenCalledWith("");
  } finally {
    await screen.unmount();
    client.clear();
  }
});
it("starts fresh polling for a second login to the same gateway", async () => {
  const configuration = await mock.request.getMockImplementation()!();
  let attempt = 0;
  let secondReads = 0;
  mock.request.mockImplementation(async ({ action }) => {
    if (action.type === "read") return configuration;
    const gateway = {
      providerId: "team",
      providerName: "Team",
      required: true,
      supportsDeviceAuth: false,
      status: "notReady",
      error: null,
    };
    if (action.type === "gatewayLogin") attempt++;
    if (action.type === "gatewayRead" && attempt === 2) secondReads++;
    return {
      gateway,
      ...(attempt
        ? {
            login: {
              loginId: "attempt-" + attempt,
              providerId: "team",
              status: action.type === "gatewayRead" && attempt === 1 ? "succeeded" : "started",
              authUrl: null,
              verificationUrl: null,
              userCode: null,
              error: null,
            },
          }
        : {}),
    };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <CodexConfigurationSection
        instanceId={ProviderInstanceId.make("codex")}
        accountIdentity="retry"
        onSelectProvider={() => undefined}
      />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole("button", { name: "Codex model providers", exact: true }).click();
    await page.getByRole("button", { name: "Check Team sign-in" }).click();
    await page.getByRole("button", { name: "Sign in to gateway", exact: true }).click();
    await expect.element(page.getByText("succeeded", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign in to gateway", exact: true }).click();
    await expect.poll(() => secondReads, { timeout: 4000 }).toBeGreaterThan(1);
    await expect.element(page.getByRole("button", { name: "Cancel gateway login" })).toBeVisible();
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("saves only edited provider fields and keeps media opt-ins off", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <CodexConfigurationSection
        instanceId={ProviderInstanceId.make("codex")}
        accountIdentity="work"
        onSelectProvider={() => undefined}
      />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole("button", { name: "Codex model providers", exact: true }).click();
    await expect
      .element(page.getByText("Authentication is configured externally and will be preserved."))
      .toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: /Audio attachments/ }))
      .not.toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: /Animated image/ })).not.toBeChecked();
    await expect
      .element(page.getByRole("button", { name: "Make Team Codex default" }))
      .toBeDisabled();
    await page.getByRole("textbox", { name: "Team name", exact: true }).fill("Renamed");
    await page.getByRole("button", { name: "Save provider", exact: true }).click();
    await expect
      .poll(() =>
        mock.request.mock.calls.some(
          ([input]) =>
            JSON.stringify(input.action) ===
            JSON.stringify({
              type: "write",
              settings: { type: "customGateway", providerId: "team", name: "Renamed" },
            }),
        ),
      )
      .toBe(true);
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("selects an F5 conversation binding without changing the native default", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const select = vi.fn();
  const screen = await render(
    <QueryClientProvider client={client}>
      <CodexConfigurationSection
        instanceId={ProviderInstanceId.make("codex")}
        accountIdentity="personal"
        onSelectProvider={select}
      />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole("button", { name: "Codex model providers", exact: true }).click();
    await page
      .getByRole("combobox", { name: /Provider for new conversations/ })
      .selectOptions("team");
    expect(select).toHaveBeenCalledWith("team");
    expect(mock.request.mock.calls.every(([input]) => input.action.type === "read")).toBe(true);
  } finally {
    await screen.unmount();
    client.clear();
  }
});

it("configures Vertex AI without requiring a pre-existing native provider entry", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <CodexConfigurationSection
        instanceId={ProviderInstanceId.make("codex")}
        accountIdentity="cloud"
        onSelectProvider={() => undefined}
      />
    </QueryClientProvider>,
  );
  try {
    await page.getByRole("button", { name: "Codex model providers", exact: true }).click();
    await page.getByRole("combobox", { name: "Add native provider" }).selectOptions("gcp");
    await page.getByRole("textbox", { name: "New gateway projectId" }).fill("my-project");
    await page.getByRole("button", { name: "Save cloud provider" }).click();
    await expect
      .poll(() =>
        mock.request.mock.calls.some(
          ([input]) =>
            input.action.type === "write" &&
            input.action.settings.type === "gcp" &&
            input.action.settings.providerId === "gcp" &&
            input.action.settings.projectId === "my-project",
        ),
      )
      .toBe(true);
  } finally {
    await screen.unmount();
    client.clear();
  }
});
