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
