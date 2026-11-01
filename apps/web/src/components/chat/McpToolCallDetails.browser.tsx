import "../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { McpToolCallDetails } from "./McpToolCallDetails";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div className="whitespace-pre-wrap">{text}</div>,
}));

const longResult = Array.from({ length: 20 }, (_, index) => `Result line ${index + 1}`).join("\n");

describe("McpToolCallDetails", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("copies pretty input JSON and the raw stored result", async () => {
    const screen = await render(
      <McpToolCallDetails
        mcpInput='{"query":"work log","limit":10,"filters":{"state":"open"}}'
        mcpResult="Found 3 issues…"
        markdownCwd={undefined}
      />,
    );
    try {
      await expect.element(page.getByTestId("mcp-input-grid")).toHaveTextContent("querywork log");
      await expect.element(page.getByText('{"state":"open"}')).toBeVisible();
      // The stored result ends with the ingestion cut marker.
      await expect.element(page.getByText("truncated")).toBeVisible();

      await page.getByRole("button", { name: "Copy input" }).click();
      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
          JSON.stringify({ query: "work log", limit: 10, filters: { state: "open" } }, null, 2),
        );
      });

      await page.getByRole("button", { name: "Copy result" }).click();
      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Found 3 issues…");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("caps a long result until it is expanded", async () => {
    const screen = await render(
      <McpToolCallDetails mcpInput="not json" mcpResult={longResult} markdownCwd={undefined} />,
    );
    try {
      await expect.element(page.getByText("not json")).toBeVisible();
      const result = page.getByTestId("mcp-result");
      await expect.element(result).toHaveClass(/max-h-28/);

      await page.getByRole("button", { name: "Show full result" }).click();
      await expect.element(result).toHaveClass(/max-h-80/);
      await expect.element(page.getByRole("button", { name: "Show less" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("omits the toggle for a result that fits", async () => {
    const screen = await render(
      <McpToolCallDetails mcpInput={undefined} mcpResult="ok" markdownCwd={undefined} failed />,
    );
    try {
      await expect.element(page.getByTestId("mcp-result")).toHaveClass(/bg-destructive\/8/);
      expect(document.body.textContent).not.toContain("Show full result");
    } finally {
      await screen.unmount();
    }
  });
});
