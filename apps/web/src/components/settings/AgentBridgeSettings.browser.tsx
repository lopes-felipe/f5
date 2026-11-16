import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { AgentBridgeSettings } from "./AgentBridgeSettings";
const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  grant: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    agentBridge: {
      getState: mocks.getState,
      setSchedulingGrant: mocks.grant,
      onStateChanged: () => () => {},
    },
  }),
}));
vi.mock("../../wsNativeApi", () => ({ onServerWelcome: () => () => {} }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    agentBridge: { ...DEFAULT_UNIFIED_SETTINGS.agentBridge, enabled: true, activationVersion: 0 },
  }),
  useUpdateSettings: () => ({ updateSettings: mocks.update }),
}));
vi.mock("./SettingsRouteContext", () => ({ useSettingsRouteContext: () => ({ projects: [] }) }));
let active: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  vi.clearAllMocks();
});
it("requires fresh activation and grants schedules separately through authenticated settings", async () => {
  mocks.getState.mockResolvedValue({
    revision: 0,
    enabled: false,
    local: { status: "stopped", port: null, detail: null },
    stdio: { desktop: null, cli: { command: "f5", args: ["agent-bridge-stdio"], env: {} } },
    clients: [
      {
        id: "local",
        kind: "local",
        name: "Local MCP client",
        label: null,
        scopes: ["f5.read", "f5.turns"],
        projectIds: [],
        grantGeneration: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
  });
  active = await render(<AgentBridgeSettings />);
  await expect.element(page.getByRole("switch", { name: "Enable Agent Bridge" })).not.toBeChecked();
  await page.getByRole("switch", { name: "Enable Agent Bridge" }).click();
  expect(mocks.update).toHaveBeenCalledWith({ agentBridge: { enabled: true } });
  await expect
    .element(page.getByRole("checkbox", { name: "Allow scheduling for Local MCP client" }))
    .not.toBeChecked();
  await page.getByRole("checkbox", { name: "Allow scheduling for Local MCP client" }).click();
  expect(mocks.grant).toHaveBeenCalledWith({
    clientId: "local",
    expectedGrantGeneration: 0,
    enabled: true,
  });
});
