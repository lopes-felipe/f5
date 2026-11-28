import { themeCssValueFetches } from "@t3tools/shared/themeCss";

// Inspect browser-parsed declarations before adopting the sheet. Unknown rules
// are dropped so they cannot introduce resource loads.
type RuleParent = Pick<CSSStyleSheet, "cssRules" | "deleteRule">;

function stripDeclarations(rule: { style: CSSStyleDeclaration }): void {
  for (let index = rule.style.length - 1; index >= 0; index--) {
    const property = rule.style.item(index);
    if (themeCssValueFetches(rule.style.getPropertyValue(property)))
      rule.style.removeProperty(property);
  }
}

function stripFetches(parent: RuleParent): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index]!;
    if ("style" in rule && rule.style instanceof CSSStyleDeclaration) {
      stripDeclarations({ style: rule.style });
    }
    if (rule instanceof CSSStyleRule) {
      stripFetches(rule);
    } else if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) stripDeclarations(frame as CSSKeyframeRule);
    } else if (rule instanceof CSSGroupingRule) {
      stripFetches(rule);
    } else if (
      !(rule instanceof CSSNamespaceRule) &&
      !(typeof CSSLayerStatementRule !== "undefined" && rule instanceof CSSLayerStatementRule) &&
      !(typeof CSSNestedDeclarations !== "undefined" && rule instanceof CSSNestedDeclarations)
    ) {
      parent.deleteRule(index);
    }
  }
}

let applied: { css: string; sheet: CSSStyleSheet } | undefined;

export function applyThemeCss(css: string | undefined): void {
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined") return;
  if (applied?.css === css) return;
  if (applied) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== applied?.sheet,
    );
    applied = undefined;
  }
  if (!css) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  stripFetches(sheet);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  applied = { css, sheet };
}
