import "../../index.css";
import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

it("expands short JSON errors to exact diagnostics and collapses to the readable message", async () => {
  const error = '  {"error": {"message":"Turn failed", "code":"unsupported_value"}}\t ';
  const screen = await render(
    <ThreadErrorBanner error={error} occurredAt="2026-10-19T12:00:00Z" />,
  );
  try {
    await expect.element(page.getByText("Turn failed", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("unsupported_value");
    await page.getByRole("button", { name: "Show full error" }).click();
    const diagnostics = page.getByText(error, { exact: true });
    await expect.element(diagnostics).toBeVisible();
    expect(diagnostics.element().textContent).toBe(error);
    await page.getByRole("button", { name: "Show less" }).click();
    await expect.element(page.getByText("Turn failed", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("unsupported_value");
  } finally {
    await screen.unmount();
  }
});
