import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Where a thread works is decided in one place, `threadWorkspaceCwd` in
 * `packages/shared/src/threadWorkspace.ts`. A local `worktreePath ?? project.cwd` fallback sends
 * a thread without a project to the shared scratch root instead of its own folder, so new
 * fallbacks from a worktree path to anything else fail here. Each remaining one names why it is
 * not a workspace decision.
 */
const ROOTS = ["apps/server/src", "apps/web/src", "packages/shared/src"];

const ALLOWED: ReadonlyArray<{ file: string; expression: string; reason: string }> = [
  {
    file: "apps/server/src/prHub/localBranchCleanup.ts",
    expression:
      "!branches.isRepo || branches.worktreeMissing || branch.isDefault || branch.current || branch.worktreePath",
    reason: "A boolean condition over a branch listing, not a path fallback.",
  },
  {
    file: "apps/server/src/wsServer.ts",
    expression: "command.worktreePath ?? project?.workspaceRoot",
    reason:
      "Only the lifecycle lock key for thread creation; the scratch folder is allocated inside dispatch.",
  },
  {
    file: "apps/server/src/project/Layers/WorktreeSetup.ts",
    expression:
      "worktreePath ??= yield* git.allocateWorktreePath({ cwd: request.projectCwd, branch: checkoutBranch, })",
    reason: "Allocates a new Git worktree path; it never falls back to a project root.",
  },
  {
    file: "apps/server/src/project/worktreeReadiness.ts",
    expression: "input.worktreePath ?? input.projectCwd",
    reason: "Git readiness of a checkout or worktree. Threads without a project never reach it.",
  },
  {
    file: "apps/server/src/orchestration/Layers/OrchestrationEngine.ts",
    expression: "thread?.worktreePath || envelope.workspace",
    reason: "A condition that decides whether to check a workspace envelope.",
  },
  {
    file: "apps/web/src/components/BranchToolbar.tsx",
    expression: "worktreePath ?? activeProject!.cwd",
    reason:
      "Attaching a project thread back to its main checkout; the toolbar is Git-only and not shown without a project.",
  },
  {
    file: "packages/shared/src/projectScripts.ts",
    expression: "input.worktreePath ?? input.project.cwd",
    reason: "Project actions run only in projects; a thread without a project has none.",
  },
];

const FALLBACK = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !/\.(test|browser)\.tsx?$/.test(name))
    .map((name) => path.join(dir, name));
}

function isFallback(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && FALLBACK.has(node.operatorToken.kind);
}

function operands(node: ts.Expression, out: ts.Expression[] = []): ts.Expression[] {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (isFallback(inner)) {
    operands(inner.left, out);
    operands(inner.right, out);
  } else out.push(inner);
  return out;
}

function isWorktreePath(node: ts.Expression): boolean {
  const inner = ts.isNonNullExpression(node) ? node.expression : node;
  return (
    (ts.isPropertyAccessExpression(inner) && inner.name.text === "worktreePath") ||
    (ts.isIdentifier(inner) && inner.text === "worktreePath")
  );
}

function isEmptyValue(node: ts.Expression): boolean {
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isStringLiteral(node)
  );
}

/** Every outermost fallback chain that moves from a worktree path to some other value. */
function worktreeFallbacks(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (isFallback(node) && !isFallback(node.parent)) {
      const chain = operands(node);
      if (
        chain.some(isWorktreePath) &&
        chain.some((operand) => !isWorktreePath(operand) && !isEmptyValue(operand))
      )
        found.push(node.getText(source).replace(/\s+/g, " "));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("thread workspace guard", () => {
  it("flags a worktree fallback to a project root and ignores plain normalization", () => {
    expect(
      worktreeFallbacks(
        "fixture.ts",
        [
          "const a = thread.worktreePath ?? project.cwd;",
          "const b = thread?.worktreePath ?? draft?.worktreePath ?? null;",
          "const c = (thread.worktreePath || '') ;",
          "const d = threadWorkspaceCwd(thread, project) ?? null;",
        ].join("\n"),
      ),
    ).toEqual(["thread.worktreePath ?? project.cwd"]);
  });

  it("resolves every thread workspace through threadWorkspaceCwd", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const found = ROOTS.flatMap((root) =>
      sourceFiles(path.join(repoRoot, root)).flatMap((file) =>
        worktreeFallbacks(file, readFileSync(file, "utf8")).map((expression) => ({
          file: path.relative(repoRoot, file).split(path.sep).join("/"),
          expression,
        })),
      ),
    );
    const allowed = ALLOWED.map(({ file, expression }) => ({ file, expression }));
    expect(found.filter((entry) => !allowed.some((allow) => sameSite(allow, entry)))).toEqual([]);
    // A stale allowance would quietly permit the next fallback in that file.
    expect(allowed.filter((allow) => !found.some((entry) => sameSite(allow, entry)))).toEqual([]);
    // Parses every server, web and shared source file; shared CI runners take several seconds.
  }, 60_000);
});

function sameSite(
  left: { file: string; expression: string },
  right: { file: string; expression: string },
) {
  return left.file === right.file && left.expression === right.expression;
}
