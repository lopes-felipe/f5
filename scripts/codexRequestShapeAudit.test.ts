import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { codexRequestShapeProbe, EXACT_CODEX_REQUEST } from "./codexRequestShapeAudit.ts";

function fixtureErrors(name: string) {
  const file = "/virtual/fixture.ts";
  const code = readFileSync(
    path.join(import.meta.dirname, "fixtures/codex-requests", name),
    "utf8",
  ).replace("/* EXACT_CODEX_REQUEST */", EXACT_CODEX_REQUEST);
  const options: ts.CompilerOptions = { types: [], lib: ["lib.es2022.d.ts"] };
  const host = ts.createCompilerHost(options);
  const readSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (id, version) =>
    id === file ? ts.createSourceFile(id, code, version, true) : readSourceFile(id, version);
  const program = ts.createProgram([file], options, host);
  return program.getSemanticDiagnostics().map((diagnostic) => diagnostic.code);
}
describe("Codex request shape audit", () => {
  it("accepts the positive request and rejects a renamed required field", () => {
    expect(fixtureErrors("positive.ts")).toEqual([]);
    expect(fixtureErrors("negative.fixture")).toContain(2741);
    expect(fixtureErrors("extra-field.fixture")).toContain(2345);
    expect(
      fixtureErrors("nested-extra-field.fixture").filter((code) => code === 2345),
    ).toHaveLength(2);
    expect(fixtureErrors("nested-positive.fixture")).toEqual([]);
  });
  it("checks real builders for every present request and omits absent fallbacks", () => {
    const probe = codexRequestShapeProbe(
      "/runtime.ts",
      "/schema",
      new Set(["thread/revert", "thread/fork"]),
    );
    expect(probe).toContain('buildCodexThreadRevertParams("thread", "turn")');
    expect(probe).toContain("const ThreadForkParamsCheck");
    expect(probe).not.toContain("const TurnStartParamsCheck");
  });
});
