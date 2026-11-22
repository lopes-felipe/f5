import { afterEach, expect, it, vi } from "vitest";
import { showBootError } from "./bootError";

afterEach(() => {
  document.getElementById("boot-shell")?.remove();
  sessionStorage.removeItem("f5:boot-failed-at");
  vi.restoreAllMocks();
});
it("shows safe startup recovery and expands repeated failures", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const shell = document.createElement("div");
  shell.id = "boot-shell";
  shell.hidden = true;
  document.body.append(shell);
  showBootError(
    new Error("<script>example</script> https://u:)secret@private-host/a.ts?t=secret:2:3"),
  );
  expect(shell.hidden).toBe(false);
  expect(shell.querySelector("script")).toBeNull();
  expect(shell.querySelector("pre")?.textContent).toContain("/a.ts:2:3");
  expect(shell.querySelector("pre")?.textContent).not.toContain("secret");
  expect(shell.querySelector("details")?.open).toBe(false);
  expect(shell.querySelector("button")?.textContent).toBe("Reload");
  showBootError("second failure");
  expect(shell.querySelector("details")?.open).toBe(true);
});
