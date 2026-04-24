import type { ThreadCompactionDirection } from "@t3tools/contracts";

export const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use any tools (file reads, shell commands, search, edits, or any other tool call).
- You already have all the context you need in the conversation below.
- Tool calls will be rejected and will waste your only turn.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`;

const DETAILED_ANALYSIS_INSTRUCTIONS = `Before providing the final summary, write a private drafting scratchpad inside <analysis> tags. In that analysis:

1. Review the provided conversation context chronologically.
2. Capture the user's explicit requests, your actions, technical decisions, file paths, code changes, errors, and user feedback.
3. Double-check the summary for technical accuracy and completeness.
`;

const BASE_COMPACTION_PROMPT = `Your task is to create a detailed summary of the conversation so far so work can continue without losing context.

${DETAILED_ANALYSIS_INSTRUCTIONS}

Your summary must contain these sections in order:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work / Completed Work
9. Next Step
`;

const PARTIAL_FROM_COMPACTION_PROMPT = `Your task is to summarize only the recent portion of the conversation. Earlier preserved context is not included here and does not need to be summarized.

${DETAILED_ANALYSIS_INSTRUCTIONS}

Your summary must contain these sections in order:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work / Completed Work
9. Next Step
`;

const PARTIAL_UP_TO_COMPACTION_PROMPT = `Your task is to summarize this earlier portion of the conversation. Newer preserved messages will follow your summary in the continued session, so the summary must preserve all context needed to understand and continue that later work.

${DETAILED_ANALYSIS_INSTRUCTIONS}

Your summary must contain these sections in order:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work / Completed Work
9. Next Step
`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only: <analysis> then <summary>.";

export function getCompactPrompt(): string {
  return `${NO_TOOLS_PREAMBLE}\n${BASE_COMPACTION_PROMPT}${NO_TOOLS_TRAILER}`;
}

export function getPartialCompactPrompt(direction: ThreadCompactionDirection): string {
  const template =
    direction === "up_to" ? PARTIAL_UP_TO_COMPACTION_PROMPT : PARTIAL_FROM_COMPACTION_PROMPT;
  return `${NO_TOOLS_PREAMBLE}\n${template}${NO_TOOLS_TRAILER}`;
}

export function formatCompactSummary(summary: string): string {
  let formatted = summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, "");
  const summaryMatches = [...formatted.matchAll(/<summary>([\s\S]*?)<\/summary>/g)];
  const summaryMatch = summaryMatches.at(-1);
  if (summaryMatch) {
    formatted = `Summary:\n${summaryMatch[1]?.trim() ?? ""}`;
  }
  return formatted.replace(/\n\n+/g, "\n\n").trim();
}
