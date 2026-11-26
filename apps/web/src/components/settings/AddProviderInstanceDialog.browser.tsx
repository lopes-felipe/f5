import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
const state = vi.hoisted(() => ({ update: vi.fn(), addToast: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: state.update }),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.addToast } }));
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  state.update.mockResolvedValue(undefined);
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});
it("names an invalid ACP field and adds the instance after correction", async () => {
  active = await render(<AddProviderInstanceDialog open onOpenChange={vi.fn()} />);
  await page.getByRole("radio", { name: "Custom ACP agent", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("textbox", { name: "Label", exact: false }).fill("Local agent");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const command = page.getByRole("textbox", { name: "Command", exact: false });
  const addInstance = page.getByRole("button", { name: "Add instance", exact: true });
  await page
    .getByRole("textbox", { name: "Arguments (JSON)", exact: false })
    .fill('["--acp","two words"]');
  await page
    .getByRole("textbox", { name: "Environment defaults (JSON)", exact: false })
    .fill('{"AGENT_HOME":"/private/home"}');
  const invalidCommand = "a".repeat(4097);
  await command.fill(invalidCommand);
  await addInstance.click();
  expect(state.addToast).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Invalid value for Command." }),
  );
  await expect.element(command).toHaveValue(invalidCommand);
  expect(state.update).not.toHaveBeenCalled();
  await command.fill("/custom/acp-agent");
  await addInstance.click();
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
