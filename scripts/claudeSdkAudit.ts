import ts from "typescript";

function literalValues(type: ts.Type): string[] {
  if (type.isUnion()) return type.types.flatMap(literalValues);
  return type.isStringLiteral() ? [type.value] : [];
}

export function extractClaudeSdkMessageSurface(
  program: ts.Program,
  source: ts.SourceFile,
): string[] {
  const checker = program.getTypeChecker();
  const declaration = source.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "SDKMessage",
  );
  if (!declaration) throw new Error("SDKMessage declaration is missing");
  const union = checker.getTypeAtLocation(declaration);
  const messages = union.isUnion() ? union.types : [union];
  const keys = messages.flatMap((type) => {
    const discriminator = type.getProperty("type");
    if (!discriminator) throw new Error("SDKMessage member lacks type");
    const names = literalValues(checker.getTypeOfSymbolAtLocation(discriminator, declaration));
    if (names.length === 0) throw new Error("SDKMessage has an unbounded discriminator");
    return names.flatMap((name) => {
      if (name !== "system") return [name];
      const subtype = type.getProperty("subtype");
      if (!subtype) throw new Error("System message lacks subtype");
      return literalValues(checker.getTypeOfSymbolAtLocation(subtype, declaration)).map(
        (value) => `system/${value}`,
      );
    });
  });
  return [...new Set(keys)].sort();
}

export function unclassifiedClaudeMessages(
  surface: readonly string[],
  dispositions: Readonly<Record<string, string>>,
): string[] {
  return surface.filter((key) => !Object.hasOwn(dispositions, key));
}

export function deprecatedClaudeSdkReferences(program: ts.Program): string[] {
  const checker = program.getTypeChecker();
  const results = new Set<string>();
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !/apps\/server\/src\/(provider|git)\//.test(source.fileName))
      continue;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        const actual =
          symbol &&
          (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
        let candidate = actual;
        if (
          ts.isPropertyAssignment(node.parent) &&
          node.parent.name === node &&
          ts.isObjectLiteralExpression(node.parent.parent)
        ) {
          candidate =
            checker.getContextualType(node.parent.parent)?.getProperty(node.text) ?? candidate;
        }
        if (
          candidate?.declarations?.some((decl) =>
            decl.getSourceFile().fileName.includes("claude-agent-sdk"),
          ) &&
          candidate.getJsDocTags(checker).some((tag) => tag.name === "deprecated")
        ) {
          const position = source.getLineAndCharacterOfPosition(node.getStart());
          results.add(`${source.fileName}:${position.line + 1} ${node.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...results].sort();
}

export function handledClaudeMessageCases(
  sourceText: string,
  handler: "handleSystemMessage" | "handleSdkMessage",
): Set<string> {
  const source = ts.createSourceFile("ClaudeAdapter.ts", sourceText, ts.ScriptTarget.Latest, true);
  const cases = new Set<string>();
  const visitCases = (node: ts.Node) => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression))
      cases.add(node.expression.text);
    ts.forEachChild(node, visitCases);
  };
  let found = false;
  const find = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === handler &&
      node.initializer
    ) {
      found = true;
      visitCases(node.initializer);
    } else ts.forEachChild(node, find);
  };
  find(source);
  if (!found) throw new Error(`${handler} declaration is missing`);
  return cases;
}
