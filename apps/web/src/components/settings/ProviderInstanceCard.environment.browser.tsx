import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ProviderEnvironmentSection } from "./ProviderInstanceCard";

const savedSecret = {
  name: "FAKE_API_KEY",
  value: "",
  sensitive: true,
  valueRedacted: true,
} as const;

describe("ProviderEnvironmentSection saved secrets", () => {
  it("requires a replacement before renaming or making a stored secret plain text", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <ProviderEnvironmentSection environment={[savedSecret]} onChange={onChange} />,
    );
    const name = screen.getByRole("textbox", { name: "Environment variable name 1" });
    const value = screen.getByLabelText("Environment variable value 1");
    const sensitive = screen.getByRole("checkbox", { name: "Sensitive" });

    await expect.element(name).toBeDisabled();
    await expect.element(sensitive).toBeDisabled();
    await expect
      .element(
        screen.getByText(/Remove and re-add a saved variable to rename it or make it plain text/),
      )
      .toBeVisible();
    await value.fill("unused-draft");
    await value.fill("");
    await userEvent.tab();
    expect(onChange).not.toHaveBeenCalled();
    await expect.element(name).toBeDisabled();
    await expect.element(sensitive).toBeDisabled();

    await value.fill("fake-replacement");
    await userEvent.tab();
    expect(onChange).toHaveBeenLastCalledWith([
      { ...savedSecret, value: "fake-replacement", valueRedacted: false },
    ]);
    await expect.element(name).toBeEnabled();
    await expect.element(sensitive).toBeEnabled();
    await name.fill("RENAMED_KEY");
    await userEvent.tab();
    await sensitive.click();
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "RENAMED_KEY", value: "fake-replacement", sensitive: false, valueRedacted: false },
    ]);
    await screen.getByRole("button", { name: "Remove environment variable RENAMED_KEY" }).click();
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("allows removing a stored secret without entering a replacement", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <ProviderEnvironmentSection environment={[savedSecret]} onChange={onChange} />,
    );

    await screen.getByRole("button", { name: "Remove environment variable FAKE_API_KEY" }).click();

    expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
  });
});
