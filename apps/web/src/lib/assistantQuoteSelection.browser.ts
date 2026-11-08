import { expect, it } from "vitest";
import { captureAssistantQuoteSelection } from "./assistantQuoteSelection";

it.each(["next-paragraph", "timestamp", "heading", "parent", "backwards"])(
  "clamps paragraph selections ending at %s to the response",
  (endpoint) => {
    const root = document.createElement("main");
    root.innerHTML =
      '<div data-message-role="assistant" data-message-id="answer"><p>Selected answer.</p></div><div style="user-select: none"><span>echo ok</span><time>12:00</time><h3>Assistant</h3></div><div data-message-role="assistant" data-message-id="next"><p>Next answer.</p></div>';
    document.body.append(root);
    const selection = window.getSelection()!;
    try {
      const first = root.querySelector("p")!.firstChild!;
      const next = root.querySelectorAll("p")[1]!;
      let end: Node = next;
      let offset = 0;
      if (endpoint === "timestamp" || endpoint === "heading") {
        end = root.querySelector(endpoint === "timestamp" ? "time" : "h3")!.firstChild!;
        offset = end.textContent!.length;
      } else if (endpoint === "parent") {
        end = root;
        offset = 2;
      }
      selection.setBaseAndExtent(
        endpoint === "backwards" ? end : first,
        endpoint === "backwards" ? offset : 0,
        endpoint === "backwards" ? first : end,
        endpoint === "backwards" ? 0 : offset,
      );
      const captured = captureAssistantQuoteSelection(selection);
      expect(captured?.source.getAttribute("data-message-id")).toBe("answer");
      expect(captured?.text).toBe("Selected answer.");
      expect(captured?.range.startContainer).toBe(first);
      expect(captured?.range.endContainer).toBe(first);
      // Capturing must not alter the native selection.
      expect(selection.focusNode).toBe(endpoint === "backwards" ? first : end);
    } finally {
      selection.removeAllRanges();
      root.remove();
    }
  },
);

it.each(["response", "user", "selectable-tool", "empty", "unselectable"])(
  "rejects selections spanning %s",
  (scenario) => {
    const root = document.createElement("main");
    root.innerHTML =
      '<div data-message-role="assistant" data-message-id="answer">First answer.</div><div data-message-role="user" data-message-id="user">User message.</div><div>Tool output</div><div data-message-role="assistant" data-message-id="next">Next answer.</div>';
    document.body.append(root);
    const selection = window.getSelection()!;
    try {
      const first = root.children[0]!.firstChild!;
      const last =
        root.children[scenario === "user" ? 1 : scenario === "selectable-tool" ? 2 : 3]!
          .firstChild!;
      if (scenario === "unselectable") root.style.userSelect = "none";
      selection.setBaseAndExtent(
        first,
        0,
        scenario === "empty" ? first : last,
        scenario === "empty" ? 0 : 3,
      );
      expect(captureAssistantQuoteSelection(selection)).toBeNull();
    } finally {
      selection.removeAllRanges();
      root.remove();
    }
  },
);
