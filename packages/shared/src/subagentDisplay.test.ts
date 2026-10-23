import { expect, it } from "vitest";
import { formatSubagentDisplayTitle } from "./subagentDisplay";

it.each([
  ["Subagent: /root/coordinator/review_api", "Review Api"],
  ["/root/analysis_tasks/", "Analysis Tasks"],
  ["subagent: Review the patch", "Review the patch"],
  ["/root/résumé_analysis", "Résumé Analysis"],
  ["Please review /root/task", "Please review /root/task"],
  ["/home/user/review_api", "/home/user/review_api"],
  ["/root/", "/root/"],
  ["Review API stability", "Review API stability"],
])("formats native subagent display title %s", (title, expected) => {
  expect(formatSubagentDisplayTitle(title)).toBe(expected);
});
