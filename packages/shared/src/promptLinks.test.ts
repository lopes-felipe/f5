import { describe, expect, it } from "vitest";

import {
  buildNewThreadLink,
  buildThreadPromptLink,
  parseNewThreadLink,
  parseThreadLinkPrompt,
  promptLinkAppPath,
  promptLinkRepositoryOfRemote,
  sanitizeLinkedPrompt,
  withoutPromptLinkParams,
} from "./promptLinks";

const char = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const ZERO_WIDTH_SPACE = char(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = char(0x202e);
const BYTE_ORDER_MARK = char(0xfeff);
const ZERO_WIDTH_JOINER = char(0x200d);

describe("sanitizeLinkedPrompt", () => {
  it("removes characters a reader cannot see and counts them", () => {
    const tagged = "rate me" + char(0xe0041, 0xe0042);
    expect(
      sanitizeLinkedPrompt(
        `a${ZERO_WIDTH_SPACE}b${RIGHT_TO_LEFT_OVERRIDE}c${BYTE_ORDER_MARK}${tagged}`,
      ),
    ).toEqual({ text: "abcrate me", hiddenCharacters: 5 });
    expect(sanitizeLinkedPrompt(`a${char(0x2028)}b${char(0x2029)}c\r\nd`)).toEqual({
      text: "a\nb\nc\nd",
      hiddenCharacters: 0,
    });
  });

  it("keeps emoji sequences intact", () => {
    const family = [char(0x1f468), char(0x1f469), char(0x1f467)].join(ZERO_WIDTH_JOINER);
    const heart = char(0x2764, 0xfe0f);
    expect(sanitizeLinkedPrompt(`${family} ${heart}`)).toEqual({
      text: `${family} ${heart}`,
      hiddenCharacters: 0,
    });
    expect(sanitizeLinkedPrompt(`a${ZERO_WIDTH_JOINER}b`).hiddenCharacters).toBe(1);
  });
});

describe("parseNewThreadLink", () => {
  it("reads a shared prompt with its optional repository and model", () => {
    expect(
      parseNewThreadLink(
        "?prompt=Rate+me&repo=https://github.com/pingdotgg/t3code.git&provider=codex&model=gpt-5",
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "new",
        prompt: { text: "Rate me", hiddenCharacters: 0 },
        repository: { owner: "pingdotgg", name: "t3code" },
        provider: "codex",
        model: "gpt-5",
      },
    });
  });

  it("reads a pull request link, whose prompt is optional", () => {
    for (const pr of [
      "pingdotgg/t3code/42",
      "pingdotgg/t3code%2342",
      "https://github.com/pingdotgg/t3code/pull/42/files",
    ]) {
      expect(parseNewThreadLink(`?pr=${pr}`)).toEqual({
        ok: true,
        value: {
          kind: "pull-request",
          pullRequest: { owner: "pingdotgg", name: "t3code", number: 42 },
          prompt: null,
        },
      });
    }
  });

  it("refuses links it cannot open safely", () => {
    expect(parseNewThreadLink("?repo=a/b").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=%E2%80%8B").ok).toBe(false);
    expect(parseThreadLinkPrompt("?prompt=%E2%80%8B").ok).toBe(false);
    expect(parseNewThreadLink("?prompt=x&repo=../etc").ok).toBe(false);
    expect(parseNewThreadLink(`?prompt=${"x".repeat(8_001)}`).ok).toBe(false);
  });
});

describe("thread links", () => {
  it("reads the prompt and leaves other parameters in place", () => {
    expect(parseThreadLinkPrompt("?prompt=Fix+it")).toEqual({
      ok: true,
      value: { text: "Fix it", hiddenCharacters: 0 },
    });
    expect(parseThreadLinkPrompt("?panel=diff")).toEqual({ ok: true, value: null });
    expect(withoutPromptLinkParams("?prompt=x&panel=diff")).toBe("?panel=diff");
  });
});

describe("link round trips", () => {
  it("builds links that open the same prompt in the app", () => {
    const link = buildNewThreadLink({
      prompt: "Swear count & rating?",
      repository: { owner: "pingdotgg", name: "t3code" },
      provider: "claudeAgent",
      model: "opus",
    });
    expect(link.startsWith("f5://new?")).toBe(true);
    const path = promptLinkAppPath(link)!;
    const parsed = parseNewThreadLink(new URL(path, "http://x").search);
    expect(parsed.ok && parsed.value.kind === "new" && parsed.value).toMatchObject({
      prompt: { text: "Swear count & rating?" },
      provider: "claudeAgent",
      model: "opus",
    });
    expect(promptLinkAppPath(buildThreadPromptLink({ threadId: "t-1", prompt: "go on" }))).toBe(
      "/t-1?prompt=go+on",
    );
  });

  it("maps only the new and thread routes to in-app paths", () => {
    expect(promptLinkAppPath("f5://new?prompt=hi")).toBe("/new?prompt=hi");
    expect(promptLinkAppPath("f5-dev://thread/abc?prompt=hi")).toBe("/abc?prompt=hi");
    expect(promptLinkAppPath("f5://thread/../settings")).toBeNull();
    expect(promptLinkAppPath("f5://thread/./abc")).toBeNull();
    expect(promptLinkAppPath("f5://thread/settings?prompt=hi")).toBeNull();
    expect(promptLinkAppPath("f5://thread/new")).toBeNull();
    expect(promptLinkAppPath("f5://settings/general")).toBeNull();
    expect(promptLinkAppPath("https://evil.test/new?prompt=hi")).toBeNull();
    expect(promptLinkAppPath("t3://app/index.html")).toBeNull();
  });

  it("forwards only the parameters each route reads", () => {
    expect(promptLinkAppPath("f5://thread/abc?prompt=x&diff=1&fileViewPath=.env")).toBe(
      "/abc?prompt=x",
    );
    expect(
      promptLinkAppPath("f5://new?prompt=x&repo=o/r&provider=codex&model=m&fileViewPath=.env"),
    ).toBe("/new?prompt=x&repo=o%2Fr&provider=codex&model=m");
    expect(promptLinkAppPath("f5://thread/abc")).toBe("/abc");
  });
});

describe("promptLinkRepositoryOfRemote", () => {
  it("reads GitHub remotes in every common form", () => {
    for (const remote of [
      "https://github.com/pingdotgg/t3code.git",
      "https://token@github.com/pingdotgg/t3code",
      "git@github.com:pingdotgg/t3code.git",
      "ssh://git@github.com/pingdotgg/t3code.git",
    ])
      expect(promptLinkRepositoryOfRemote(remote)).toEqual({ owner: "pingdotgg", name: "t3code" });
    expect(promptLinkRepositoryOfRemote("https://gitlab.com/pingdotgg/t3code.git")).toBeNull();
  });
});
