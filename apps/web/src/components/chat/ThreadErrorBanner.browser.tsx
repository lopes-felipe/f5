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

it("shows a short wrapped error in full without requiring an expansion control", async () => {
  const error = "A short error message that wraps across more than three lines in a narrow column.";
  const screen = await render(
    <div style={{ width: 100 }}>
      <ThreadErrorBanner error={error} />
    </div>,
  );
  try {
    const text = page.getByText(error, { exact: true });
    await expect.element(text).toBeVisible();
    const element = text.element();
    expect(getComputedStyle(element).webkitLineClamp).toBe("none");
    expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight + 1);
    expect(page.getByRole("button", { name: "Show full error" }).query()).toBeNull();
  } finally {
    await screen.unmount();
  }
});
