import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { expect, it, vi } from "vitest";
import { PrFileDiff } from "./PrFileDiff";

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
