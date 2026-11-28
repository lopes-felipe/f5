import "../../../index.css";
import { ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { McpPromptDialog, type McpPromptRequest } from "./McpPromptDialog";

const mocks = vi.hoisted(() => ({
  completeComposerPrompt: vi.fn(),
}));
vi.mock("../../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../nativeApi")>()),
  ensureNativeApi: () => ({ mcp: { completeComposerPrompt: mocks.completeComposerPrompt } }),
}));

const threadId = ThreadId.makeUnsafe("prompt-thread");

const promptA: McpPromptRequest = {
  serverName: "docs",
  prompt: { name: "summarize", arguments: [{ name: "topic", required: true }] },
};
const promptB: McpPromptRequest = {
  serverName: "docs",
  prompt: { name: "explain", arguments: [{ name: "topic", required: true }] },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The dialog with its request owned by a parent, as ChatView owns it. */
function Harness(props: {
  initial: McpPromptRequest;
  onInsert: (values: Record<string, string>) => Promise<boolean>;
  expose: (open: (request: McpPromptRequest | null) => void) => void;
}) {
  const [request, setRequest] = useState<McpPromptRequest | null>(props.initial);
  props.expose(setRequest);
  return (
    <McpPromptDialog
      threadId={threadId}
      request={request}
      onOpenChange={(open) => {
        if (!open) setRequest(null);
      }}
      onInsert={props.onInsert}
    />
  );
}

describe("McpPromptDialog", () => {
  // Typing schedules a debounced completion request; a test that doesn't stub it must still
  // get a promise, or the request throws once the debounce fires mid-test.
  beforeEach(() => {
    mocks.completeComposerPrompt.mockResolvedValue({ values: [] });
  });
  afterEach(() => {
    mocks.completeComposerPrompt.mockReset();
    document.body.innerHTML = "";
  });

  it("treats server argument names such as constructor as plain fields", async () => {
    const screen = await render(
      <McpPromptDialog
        threadId={threadId}
        request={{
          serverName: "docs",
          prompt: {
            name: "odd",
            arguments: [
              { name: "constructor", required: true },
              { name: "toString", required: false },
            ],
          },
        }}
        onOpenChange={() => {}}
        onInsert={async () => true}
      />,
    );
    try {
      const insert = page.getByRole("button", { name: "Insert prompt" });
      await expect.element(insert).toBeDisabled();
      await page.getByLabelText("constructor").fill("value");
      await expect.element(insert).toBeEnabled();
      await expect.element(page.getByLabelText("toString")).toHaveValue("");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a newer prompt open, without the last prompt's suggestions", async () => {
    const completion = deferred<{ values: string[] }>();
    mocks.completeComposerPrompt.mockReturnValue(completion.promise);
    const insertion = deferred<boolean>();
    const onInsert = vi.fn(() => insertion.promise);
    let open!: (request: McpPromptRequest | null) => void;
    const screen = await render(
      <Harness
        initial={promptA}
        onInsert={onInsert}
        expose={(setter) => {
          open = setter;
        }}
      />,
    );
    try {
      await page.getByLabelText("topic").fill("cats");
      await vi.waitFor(() => expect(mocks.completeComposerPrompt).toHaveBeenCalled());
      await page.getByRole("button", { name: "Insert prompt" }).click();
      await vi.waitFor(() => expect(onInsert).toHaveBeenCalledWith({ topic: "cats" }));

      // Another prompt opens while A's suggestions and insertion are still running.
      open(promptB);
      await expect.element(page.getByText("/docs:explain")).toBeVisible();
      completion.resolve({ values: ["from A"] });
      insertion.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      await expect.element(page.getByText("/docs:explain")).toBeVisible();
      expect(document.querySelector("datalist")).toBeNull();
      await expect.element(page.getByLabelText("topic")).toHaveValue("");
    } finally {
      await screen.unmount();
    }
  });
});
