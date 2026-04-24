import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { ReasoningSection } from "./ReasoningSection";

describe("ReasoningSection", () => {
  it("renders the reasoning label and content when expanded", () => {
    const markup = renderToStaticMarkup(
      <ReasoningSection
        reasoningText="Thinking through the options"
        defaultExpanded
        isStreaming={false}
        cwd={undefined}
      />,
    );

    expect(markup).toContain("Thinking");
    expect(markup).toContain("Thinking through the options");
  });
});
