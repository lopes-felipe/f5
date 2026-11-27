import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { classifyReadOnlyShellCommand } from "./readOnlyWorkflowShell.ts";

/**
 * The classifier reads commands with a bash parser, but Codex and the ACP agents run them in zsh.
 * These tests ask zsh itself what a word expands to and hold the classifier to it: a word the
 * classifier accepts must reach the program as the text the classifier checked. They run where
 * zsh is installed (macOS; skipped elsewhere).
 */
const zshOutput = (script: string): string | undefined => {
  const result = spawnSync("zsh", ["-f", "-c", script], { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? result.stdout : undefined;
};
const hasZsh = zshOutput("print -r -- ok") === "ok\n";

const SETUP = "X=a/b; Y=--output=pwned";
/** What zsh passes for `word`, or undefined when zsh rejects the script. */
const expandedByZsh = (word: string) => {
  const output = zshOutput(`${SETUP}; print -r -- ${word}`);
  return output?.endsWith("\n") ? output.slice(0, -1) : output;
};
const accepted = (word: string) => classifyReadOnlyShellCommand(`${SETUP}; echo ${word}`).readOnly;

describe.skipIf(!hasZsh)("the classifier's reading of a word against zsh", () => {
  it.each([
    // [word as written, the text the classifier checks]
    ["${X}:h", "a/b:h"],
    ['"${X}[1]"', "a/b[1]"],
    ['"$X":h', "a/b:h"],
    ["$X\\:h", "a/b:h"],
    ["$X\\[1]", "a/b[1]"],
    ['"^import$"', "^import$"],
    ['"foo$|bar$"', "foo$|bar$"],
    ['"(a|b$)"', "(a|b$)"],
    ['"a$ b"', "a$ b"],
    ['"$"X', "$X"],
    ["foo$", "foo$"],
    ["a$.b", "a$.b"],
    ["a$/b", "a$/b"],
    ["a$,b", "a$,b"],
    ["a$:b", "a$:b"],
    ["a$%b", "a$%b"],
    ["\\$=X", "$=X"],
    ["a$\\=X", "a$=X"],
    ["'$=X'", "$=X"],
    ["$'$=X'", "$=X"],
  ])("accepts %s, which zsh passes as %s", (word, text) => {
    expect(accepted(word), word).toBe(true);
    expect(expandedByZsh(word), word).toBe(text);
  });

  it.each([
    // [word as written, how a bash parser reads it]
    ["$=Y", "$=Y"],
    ['"$=Y"', "$=Y"],
    ["$~Y", "$~Y"],
    ['"$~Y"', "$~Y"],
    ["$^Y", "$^Y"],
    ["$==Y", "$==Y"],
    ["$+Y", "$+Y"],
    ["$\\\n=Y", "$=Y"],
    ["$X:h", "a/b:h"],
    ['"$X:h"', "a/b:h"],
    ["$X\\\n:h", "a/b:h"],
    ['"$X[1]"', "a/b[1]"],
  ])("refuses %s, which zsh does not pass as %s", (word, bashReading) => {
    expect(expandedByZsh(word), word).not.toBe(bashReading);
    expect(accepted(word), word).toBe(false);
  });

  // Every printable character after a `$`: where the classifier takes `$<char>` for text, zsh
  // must too. A new parser or classifier rule that lets one through fails here.
  it("never accepts a `$<character>` that zsh expands", () => {
    const acceptedCharacters: string[] = [];
    for (let code = 33; code < 127; code += 1) {
      const character = String.fromCharCode(code);
      const forms = [
        // Inside double quotes these would end or escape the quote.
        ...('"`\\'.includes(character) ? [] : [`"a$${character}X"`]),
        // Unquoted, these end the word or start something that is not one.
        ...("\"'`\\;&|<>()#".includes(character) ? [] : [`a$${character}X`]),
      ];
      for (const word of forms) {
        if (!accepted(word)) continue;
        acceptedCharacters.push(character);
        expect(expandedByZsh(word), word).toBe(`a$${character}X`);
      }
    }
    // The sweep is not vacuous: these stay text in zsh, and are accepted.
    expect(acceptedCharacters).toEqual(expect.arrayContaining([".", "/", ":", ",", "%", "|"]));
  });
});
