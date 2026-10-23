import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MermaidDiagram } from "./MermaidDiagram";

afterEach(() => {
  document.body.innerHTML = "";
});

async function image(host: HTMLElement) {
  await vi.waitFor(() => expect(host.querySelector("img")?.complete).toBe(true), {
    timeout: 15_000,
  });
  const img = host.querySelector("img")!;
  expect(img.naturalWidth).toBeGreaterThan(0);
  return img;
}

describe("Mermaid diagrams", () => {
  it("renders a real SVG, switches source in place and redraws on a theme change", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const source = "flowchart LR\n  First --> Second";
    const view = await render(
      <MermaidDiagram source={source} theme="light" code={<pre>{source}</pre>} />,
      { container: host },
    );
    const lightImage = await image(host);
    const firstUrl = lightImage.src;
    const lightSvg = await (await fetch(firstUrl)).text();
    expect(lightSvg).toContain("First");
    await view.getByRole("button", { name: "Show code" }).click();
    expect(host.querySelector("pre")?.textContent).toBe(source);
    expect(host.querySelector("img")).toBeNull();
    await view.getByRole("button", { name: "Show diagram" }).click();
    expect((await image(host)).src).toBe(firstUrl);
    await view.rerender(<MermaidDiagram source={source} theme="dark" code={<pre>{source}</pre>} />);
    await vi.waitFor(() => expect(host.querySelector("img")?.src).not.toBe(firstUrl));
    const darkSvg = await (await fetch((await image(host)).src)).text();
    expect(darkSvg).not.toBe(lightSvg);
    expect(host.querySelector("svg")).toBeNull();
    expect(document.querySelector('[id^="f5-mermaid-"]')).toBeNull();
  });

  it("keeps invalid diagrams readable and removes the temporary rendering DOM", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const source = "this is not a diagram";
    const view = await render(
      <MermaidDiagram source={source} theme="light" code={<pre>{source}</pre>} />,
      { container: host },
    );
    await expect
      .element(view.getByText("Unable to render diagram. You can view or copy its source."))
      .toBeVisible();
    expect(host.querySelector("pre")?.textContent).toBe(source);
    expect(document.querySelector('[id^="f5-mermaid-"]')).toBeNull();
    await expect.element(view.getByRole("button", { name: "Retry diagram" })).toBeVisible();
  });

  it("does not promote a diagram's scripts or links into the application", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const source = `%%{init: {"securityLevel":"loose", "htmlLabels":true, "flowchart":{"htmlLabels":true}}}%%
flowchart LR
 A["<img src=x onerror=window.mermaidInjected=true>"] --> B[Safe]
 click B "javascript:window.mermaidInjected=true"`;
    await render(<MermaidDiagram source={source} theme="light" code={<pre>{source}</pre>} />, {
      container: host,
    });
    const img = await image(host);
    expect(img.src).toMatch(/^blob:/);
    expect(host.querySelector("a,svg,script,iframe")).toBeNull();
    expect(Reflect.get(window, "mermaidInjected")).toBeUndefined();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    const svg = await (await fetch(img.src)).text();
    expect(svg).not.toContain("<foreignObject");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("javascript:");
  });

  it("defers off-screen diagrams and bounds oversized source", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.style.marginTop = "100000px";
    const view = await render(
      <MermaidDiagram
        source={"x".repeat(50_001)}
        theme="light"
        code={<pre>Oversized source</pre>}
      />,
      { container: host },
    );
    expect(host.querySelector("img,pre")).toBeNull();
    host.style.marginTop = "0";
    await expect
      .element(view.getByText("Unable to render diagram. You can view or copy its source."))
      .toBeVisible();
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe("Oversized source");
  });
});
