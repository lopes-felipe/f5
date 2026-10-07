import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { codexRequestShapeProbe } from "./codexRequestShapeAudit.ts";

function fixtureErrors(name: string) {
  const file = "/virtual/fixture.ts";
  const code = readFileSync(
    path.join(import.meta.dirname, "fixtures/codex-requests", name),
    "utf8",
  );
  const host = ts.createCompilerHost({ noLib: true });
  host.getSourceFile = (id, version) =>
    id === file ? ts.createSourceFile(id, code, version, true) : undefined;
  const program = ts.createProgram([file], { noLib: true }, host);
  return program.getSemanticDiagnostics().map((diagnostic) => diagnostic.code);
}
describe("Codex request shape audit", () => {
  it("accepts the positive request and rejects a renamed required field", () => {
    expect(fixtureErrors("positive.ts")).toEqual([]);
    expect(fixtureErrors("negative.fixture")).toContain(2741);
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
