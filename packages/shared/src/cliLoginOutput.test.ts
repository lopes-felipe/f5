import { expect, it } from "vitest";
import { accountLoginOutput } from "./cliLoginOutput";
it("waits for a complete URL across chunks and preserves OAuth query bytes", () => {
  const partial = "Open https://auth.openai.com/oauth/authorize?state=abc";
  expect(accountLoginOutput(partial).urls).toEqual([]);
  const url =
    "https://auth.openai.com/oauth/authorize?state=abcdef&redirect_uri=http%3A%2F%2Flocalhost%3A1455";
  expect(accountLoginOutput("Open " + url + "\r\n").urls).toEqual([url]);
});
it("removes terminal styling and hyperlink control sequences and deduplicates links", () => {
  const url = "https://auth.openai.com/codex/device";
  const output = `\x1b[32m${url}\x1b[0m\n\x1b]8;;${url}\x07${url}\x1b]8;;\x07\n`;
  expect(accountLoginOutput(output)).toEqual({ text: `${url}\n${url}\n`, urls: [url] });
});

it("does not treat a split terminal escape as a URL terminator", () => {
  expect(accountLoginOutput("https://auth.openai.com/oauth?state=abc\x1b[").urls).toEqual([]);
});
