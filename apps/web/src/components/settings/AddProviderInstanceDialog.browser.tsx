import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
const state = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: state.update }),
}));
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  state.update.mockResolvedValue(undefined);
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
it("adds a named custom ACP instance with typed argv and environment defaults", async () => {
  active = await render(<AddProviderInstanceDialog open onOpenChange={vi.fn()} />);
  await page.getByRole("radio", { name: "Custom ACP agent", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("textbox", { name: "Label", exact: false }).fill("Local agent");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("textbox", { name: "Command", exact: false }).fill("/custom/acp-agent");
  await page
    .getByRole("textbox", { name: "Arguments (JSON)", exact: false })
    .fill('["--acp","two words"]');
  await page
    .getByRole("textbox", { name: "Environment defaults (JSON)", exact: false })
    .fill('{"AGENT_HOME":"/private/home"}');
  expect(state.update).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Add instance", exact: true }).click();
  expect(state.update).toHaveBeenCalledWith(
    expect.objectContaining({
      providerInstances: expect.objectContaining({
        acp_local_agent: expect.objectContaining({
          driver: "acp",
          config: {
            command: "/custom/acp-agent",
            args: ["--acp", "two words"],
            env: { AGENT_HOME: "/private/home" },
          },
        }),
      }),
    }),
  );
});
