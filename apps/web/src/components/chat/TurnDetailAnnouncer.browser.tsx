import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { MessageId, TurnId } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";
import { TurnDetailAnnouncer } from "./TurnDetailAnnouncer";

const turnId = TurnId.make("turn");
const message = (streaming: boolean): TimelineEntry => ({
  id: "message",
  kind: "message",
  createdAt: "2026-11-17T00:00:00Z",
  message: {
    id: MessageId.make("message"),
    turnId,
    role: "assistant",
    text: "Finished inspecting.",
    streaming,
    createdAt: "2026-11-17T00:00:00Z",
  },
});
const work: TimelineEntry = {
  id: "tool",
  kind: "work",
  createdAt: "2026-11-17T00:00:01Z",
  entry: {
    id: "tool",
    createdAt: "2026-11-17T00:00:01Z",
    turnId,
    tone: "tool",
    label: "Reading source",
    status: "inProgress",
  },
};
describe("turn detail live region", () => {
  it("speaks settled messages and clears pending speech on a thread switch", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const base = {
      threadId: "one",
      turnId,
      level: "everything" as const,
      active: true,
      working: true,
    };
    const screen = await render(<TurnDetailAnnouncer {...base} entries={[message(true)]} />, {
      container: host,
    });
    try {
      const region = () => host.querySelector("[aria-live]")!.textContent;
      expect(region()).toBe("");
      await screen.rerender(<TurnDetailAnnouncer {...base} entries={[message(false), work]} />);
      await expect.poll(region).toBe("F5: Finished inspecting.");
      await screen.rerender(<TurnDetailAnnouncer {...base} threadId="two" entries={[work]} />);
      expect(region()).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(region()).toBe("");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
  it("leaves the default status-only live region empty through streaming and completion", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const base = { threadId: "one", turnId, level: "status" as const, active: true, working: true };
    const screen = await render(<TurnDetailAnnouncer {...base} entries={[message(true)]} />, {
      container: host,
    });
    try {
      await screen.rerender(<TurnDetailAnnouncer {...base} entries={[message(false), work]} />);
      expect(host.querySelector("[aria-live]")!.textContent).toBe("");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
