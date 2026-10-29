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

    expect(markup).toContain("Thought");
    expect(markup).toContain("Thinking through the options");
  });

  it("labels a streaming section as thinking", () => {
    const markup = renderToStaticMarkup(
      <ReasoningSection
        reasoningText="Still going"
        reasoningTokens={1200}
        defaultExpanded={false}
        isStreaming
        cwd={undefined}
      />,
    );

    expect(markup).toContain("Thinking…");
    expect(markup).not.toContain("Thought");
  });

  it("shows a provider-reported count without a tilde", () => {
    const markup = renderToStaticMarkup(
      <ReasoningSection
        reasoningText="Reasoning"
        reasoningTokens={1234}
        reasoningTokensEstimated={false}
        defaultExpanded={false}
        isStreaming={false}
        cwd={undefined}
      />,
    );

    expect(markup).toContain("· 1.2K tokens");
    expect(markup).not.toContain("~");
    expect(markup).toContain('title="Reported by provider"');
  });

  it("marks an estimated count with a tilde", () => {
    const markup = renderToStaticMarkup(
      <ReasoningSection
        reasoningText="Reasoning"
        reasoningTokens={850}
        reasoningTokensEstimated
        defaultExpanded={false}
        isStreaming={false}
        cwd={undefined}
      />,
    );

    expect(markup).toContain("· ~850 tokens");
    expect(markup).toContain('title="Approximate estimate"');
  });

  it("renders a count without reasoning text as a static row", () => {
    const markup = renderToStaticMarkup(
      <ReasoningSection
        reasoningText=""
        reasoningTokens={516}
        defaultExpanded
        isStreaming={false}
        cwd={undefined}
      />,
    );

    expect(markup).toContain('data-slot="reasoning-summary"');
    expect(markup).toContain("516 tokens");
    expect(markup).not.toContain("<button");
  });

  it("omits the count when none is known", () => {
    const markup = renderToStaticMarkup(
      <ReasoningSection
        reasoningText="Reasoning"
        defaultExpanded={false}
        isStreaming={false}
        cwd={undefined}
      />,
    );

    expect(markup).not.toContain("tokens");
  });
});
