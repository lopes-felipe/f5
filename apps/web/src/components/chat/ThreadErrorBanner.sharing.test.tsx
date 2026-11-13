import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimit";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ChatGPT sharing recovery", () => {
  it("offers an admin request for workspace limits", () => {
    const html = renderToStaticMarkup(
      <ThreadErrorBanner error={CHATGPT_WORKSPACE_USAGE_LIMIT_CODE} />,
    );
    expect(html).toContain("ChatGPT usage limit reached");
    expect(html).toContain("Copy request for admin");
    expect(html).not.toContain("Manage usage");
  });
  it("links personal limits to ChatGPT usage settings", () => {
    const html = renderToStaticMarkup(<ThreadErrorBanner error={CHATGPT_USAGE_LIMIT_CODE} />);
    expect(html).toContain("Manage usage");
    expect(html).toContain("https://chatgpt.com/#settings/Usage");
    expect(html).not.toContain("Copy request for admin");
  });
});
