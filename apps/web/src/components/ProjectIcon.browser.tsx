import { ProjectId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProjectIcon } from "./ProjectIcon";

describe("ProjectIcon", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders scratch as a message icon without loading a favicon, even with a manual icon", async () => {
    const resources: string[] = [];
    const observer = new PerformanceObserver((list) => {
      resources.push(...list.getEntries().map((entry) => entry.name));
    });
    observer.observe({ type: "resource" });
    try {
      const screen = await render(
        <ProjectIcon kind="scratch" icon={{ type: "emoji", emoji: "X" }} />,
      );
      expect(screen.container.querySelector("svg.lucide-message-square")).not.toBeNull();
      expect(screen.container.querySelector("img")).toBeNull();
      // Flush pending resource observations before checking for requests.
      await vi.waitFor(() => expect(screen.container.querySelector("svg")).not.toBeNull());
      resources.push(...observer.takeRecords().map((entry) => entry.name));
      expect(resources.some((url) => url.includes("/api/project-favicon"))).toBe(false);
    } finally {
      observer.disconnect();
    }
  });

  it("keeps standard project favicon requests keyed by project id", async () => {
    const screen = await render(
      <ProjectIcon projectId={ProjectId.makeUnsafe("alpha")} name="Alpha" />,
    );
    expect(screen.container.querySelector("img")?.getAttribute("src")).toContain(
      "/api/project-favicon?projectId=alpha",
    );
  });
  it("requests the selected image and updates it when its saved path changes", async () => {
    const projectId = ProjectId.makeUnsafe("alpha");
    const screen = await render(
      <ProjectIcon
        projectId={projectId}
        name="Alpha"
        icon={{ type: "image", path: "assets/logo.svg" }}
      />,
    );
    expect(screen.container.querySelector("img")?.getAttribute("src")).toContain(
      "iconPath=assets%2Flogo.svg",
    );
    await screen.rerender(
      <ProjectIcon
        projectId={projectId}
        name="Alpha"
        icon={{ type: "image", path: "other.svg" }}
      />,
    );
    expect(screen.container.querySelector("img")?.getAttribute("src")).toContain(
      "iconPath=other.svg",
    );
  });
});
