import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("declares every event handled by each projector, including helper guards", () => {
  const source = ts.createSourceFile(
    "ProjectionPipeline.ts",
    readFileSync(new URL("./ProjectionPipeline.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = new Map<string, ts.Expression>();
  const index = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      declarations.set(node.name.text, node.initializer);
    ts.forEachChild(node, index);
  };
  // The operational scheduler projector lives in a separate module. Follow its
  // factory too, so its filter gets the same completeness check as local ones.
  index(
    ts.createSourceFile(
      "scheduledTasks/projector.ts",
      readFileSync(new URL("../../scheduledTasks/projector.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    ),
  );
  index(source);
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
      ? unwrap(node.expression)
      : node;
  const arrayValues = (node: ts.Expression): string[] => {
    const value = unwrap(node);
    if (ts.isIdentifier(value)) {
      const declaration = declarations.get(value.text);
      if (!declaration) throw new Error(`Missing event list: ${value.text}`);
      return arrayValues(declaration);
    }
    if (!ts.isArrayLiteralExpression(value)) throw new Error("Expected a literal event list");
    return value.elements.map((item) => {
      if (!ts.isStringLiteral(item)) throw new Error("Expected a literal event type");
      return item.text;
    });
  };
  const handledTypes = (expression: ts.Expression) => {
    const types = new Set<string>();
    const visited = new Set<ts.Node>();
    const isType = (node: ts.Node) =>
      ts.isPropertyAccessExpression(node) && node.name.text === "type";
    const literal = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && /^(?:thread|project)\./.test(node.text)) types.add(node.text);
    };
    const visit = (node: ts.Node) => {
      if (visited.has(node)) return;
      visited.add(node);
      if (ts.isSwitchStatement(node) && isType(node.expression)) {
        for (const clause of node.caseBlock.clauses)
          if (ts.isCaseClause(clause)) literal(clause.expression);
      }
      if (
        ts.isBinaryExpression(node) &&
        [
          ts.SyntaxKind.EqualsEqualsEqualsToken,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ].includes(node.operatorToken.kind)
      ) {
        if (isType(node.left)) literal(node.right);
        if (isType(node.right)) literal(node.left);
      }
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const helper = declarations.get(node.expression.text);
          if (helper) visit(helper);
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "includes" &&
          node.arguments.some(isType)
        ) {
          for (const type of arrayValues(node.expression.expression)) types.add(type);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return [...types].sort();
  };
  const projectors = declarations.get("projectors");
  expect(projectors && ts.isArrayLiteralExpression(projectors)).toBe(true);
  if (!projectors || !ts.isArrayLiteralExpression(projectors)) return;
  expect(projectors.elements.length).toBeGreaterThan(0);
  for (const projector of projectors.elements) {
    if (!ts.isObjectLiteralExpression(projector)) throw new Error("Expected a literal projector");
    const properties = new Map(
      projector.properties
        .filter(ts.isPropertyAssignment)
        .map((p) => [p.name.getText(source), p.initializer]),
    );
    const handler = properties.get("apply"),
      declared = properties.get("eventTypes");
    if (!handler || !ts.isIdentifier(handler) || !declared)
      throw new Error("Missing projector registration");
    const body = declarations.get(handler.text);
    if (!body) throw new Error(`Missing handler: ${handler.text}`);
    expect(arrayValues(declared).sort(), handler.text).toEqual(handledTypes(body));
  }
});
