import "../index.css";

import type { ComponentProps } from "react";
import type { ProjectScript } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import ProjectScriptsControl from "./ProjectScriptsControl";

const TEST_SCRIPT: ProjectScript = {
  id: "test",
  name: "Test",
  command: "bun test",
  icon: "test",
  runOnWorktreeCreate: false,
};

function renderControl(overrides: Partial<ComponentProps<typeof ProjectScriptsControl>> = {}) {
  return render(
    <div data-testid="host">
      <ProjectScriptsControl
        scripts={[]}
        keybindings={[]}
        onRunScript={() => {}}
        onAddScript={() => {}}
        onUpdateScript={() => {}}
        onDeleteScript={() => {}}
        {...overrides}
      />
    </div>,
  );
}

describe("ProjectScriptsControl", () => {
  it("renders nothing in the header until the project has an action", async () => {
    await renderControl();
    await expect.element(page.getByTestId("host")).toBeInTheDocument();
    expect(document.querySelector('[data-testid="host"]')?.childElementCount).toBe(0);
    expect(page.getByText("Add action").all()).toHaveLength(0);
  });

  it("runs the primary action and offers Add action from the chevron menu", async () => {
    const ran: string[] = [];
    await renderControl({ scripts: [TEST_SCRIPT], onRunScript: (script) => ran.push(script.id) });

    await page.getByTitle("Run Test").click();
    expect(ran).toEqual(["test"]);

    await page.getByRole("button", { name: "Script actions" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Test" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Add action" }).click();
    await expect.element(page.getByRole("dialog", { name: "Add Action" })).toBeVisible();
  });
});
