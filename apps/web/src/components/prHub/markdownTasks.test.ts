import { expect, it } from "vitest";
import { taskMarkerOffset, setTaskChecked } from "./markdownTasks";

it("changes only the parser-selected task, preserving CRLF and other markers", () => {
  const body = "1. [X] first\r\n   - [ ] nested\r\n";
  const start = body.indexOf("-");
  const offset = taskMarkerOffset(body, start)!;
  expect(setTaskChecked(body, offset, true)).toBe("1. [X] first\r\n   - [x] nested\r\n");
  expect(setTaskChecked(body, 0, false)).toBe(body);
  expect(taskMarkerOffset("- ordinary", 0)).toBeNull();
});
