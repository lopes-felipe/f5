import type { InlineCode } from "mdast";

type Code = number | null;
type State = (code: Code) => State | undefined;
interface Effects {
  enter(type: string): void;
  exit(type: string): void;
  consume(code: Code): void;
  attempt(construct: { tokenize: Tokenizer }, ok: State, nok: State): State;
}
type Tokenizer = (effects: Effects, ok: State, nok: State) => State;

// Tokenize before CommonMark consumes TeX escapes, underscores, or asterisks.
// Code spans and fenced blocks keep their own tokenizer.
const tokenize: Tokenizer = (effects, ok, nok) => {
  let close = [36];
  let display = false;
  let hasContent = false;
  let dataOpen = false;
  const end: Tokenizer = (inner, done, fail) => {
    let index = 0;
    const next: State = (code) => {
      if (index === close.length) {
        if (!display && close.length === 1 && code !== null && code >= 48 && code <= 57)
          return fail(code);
        inner.exit("f5MathClose");
        return done(code);
      }
      if (code !== close[index]) return fail(code);
      if (index === 0) inner.enter("f5MathClose");
      inner.consume(code);
      index++;
      return next;
    };
    return next;
  };
  const content: State = (code) => {
    if (code === null || (!display && code < 0)) return nok(code);
    if (code === close[0] && hasContent) {
      if (dataOpen) {
        effects.exit("f5MathData");
        dataOpen = false;
      }
      return effects.attempt({ tokenize: end }, finished, consume)(code);
    }
    return consume(code);
  };
  const consume: State = (code) => {
    if (code === null) return nok(code);
    hasContent = true;
    if (code < 0) {
      if (dataOpen) {
        effects.exit("f5MathData");
        dataOpen = false;
      }
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return content;
    }
    if (!dataOpen) {
      effects.enter("f5MathData");
      dataOpen = true;
    }
    effects.consume(code);
    return content;
  };
  const finished: State = (code) => {
    effects.exit("f5Math");
    return ok(code);
  };
  const afterDollar: State = (code) => {
    if (code === 36) {
      effects.consume(code);
      display = true;
      close = [36, 36];
      return content;
    }
    if (code === 32 || code === 9 || code === null || code < 0) return nok(code);
    return content(code);
  };
  const afterSlash: State = (code) => {
    if (code !== 40 && code !== 91) return nok(code);
    display = code === 91;
    close = [92, display ? 93 : 41];
    effects.consume(code);
    return content;
  };
  return (code) => {
    effects.enter("f5Math");
    effects.consume(code);
    return code === 92 ? afterSlash : afterDollar;
  };
};

interface CompileContext {
  enter(node: InlineCode, token: unknown): void;
  exit(token: unknown): void;
  sliceSerialize(token: unknown): string;
}

export function remarkMath(this: unknown) {
  const data = (
    this as {
      data(): {
        micromarkExtensions?: unknown[];
        fromMarkdownExtensions?: unknown[];
      };
    }
  ).data();
  (data.micromarkExtensions ??= []).push({
    text: {
      36: { name: "f5Math", tokenize },
      92: { name: "f5Math", tokenize },
    },
  });
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      f5Math(this: CompileContext, token: unknown) {
        const source = this.sliceSerialize(token);
        const display = source.startsWith("$$") || source.startsWith("\\[");
        const width = source.startsWith("$") && !display ? 1 : 2;
        this.enter(
          {
            type: "inlineCode",
            value: source.slice(width, -width),
            data: {
              hProperties: {
                className: ["language-math", display ? "math-display" : "math-inline"],
              },
            },
          },
          token,
        );
      },
    },
    exit: {
      f5Math(this: CompileContext, token: unknown) {
        this.exit(token);
      },
    },
  });
}
