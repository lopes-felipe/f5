import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { expect, it, vi } from "vitest";
import { PrFileDiff } from "./PrFileDiff";
import { readAppSettingsSnapshot, updateAppSettings } from "../../appSettings";

it("does not hide a shortened diff when only its omitted suffix changed", async () => {
  const original = readAppSettingsSnapshot().diffIgnoreWhitespace;
  updateAppSettings({ diffIgnoreWhitespace: true });
  const line = "x".repeat(1999) + "… (line shortened)";
  const file = { path: "example.txt", changeType: "changed", additions: 1, deletions: 1 } as const;
  const view = await render(
    <PrFileDiff
      file={{ ...file, patchStatus: "unavailable" }}
      scope="shortened"
      url="https://github.com/example/repository/pull/1/files"
      loadDiff={async () => ({
        ...file,
        hasShortenedLines: true,
        patchStatus: "available",
        patch:
          "diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-" +
          line +
          "\n+" +
          line +
          "\n",
      })}
    />,
  );
  try {
    await page.getByRole("button", { name: "Load diff" }).click();
    await expect.element(page.getByRole("button", { name: "Load diff" })).not.toBeInTheDocument();
    await expect.element(page.getByText(/Only whitespace changes/)).not.toBeInTheDocument();
  } finally {
    await view.unmount();
    updateAppSettings({ diffIgnoreWhitespace: original });
  }
});

it("loads a withheld GitHub diff on request and reports download errors", async () => {
  const loadDiff = vi.fn().mockRejectedValue(new Error("Open the complete diff on GitHub."));
  await render(
    <PrFileDiff
      file={{
        path: "example.txt",
        changeType: "changed",
        additions: 128,
        deletions: 128,
        patchStatus: "unavailable",
      }}
      scope="github-test"
      url="https://github.com/example/repository/pull/1/files"
      loadDiff={loadDiff}
    />,
  );
  await expect
    .element(page.getByText("Diff too large to display.", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByRole("link", { name: "Open on GitHub" })).toBeVisible();
  expect(loadDiff).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Load diff" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Open the complete diff on GitHub.");
  expect(loadDiff).toHaveBeenCalledTimes(1);
});
