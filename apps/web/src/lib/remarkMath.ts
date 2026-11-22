import type { Text, Root, RootContent } from "mdast";
type MathNode = Omit<Text, "type"> & { type: "f5Math" };
declare module "mdast" {
  interface PhrasingContentMap {
    f5Math: MathNode;
  }
  interface RootContentMap {
    f5Math: MathNode;
  }
}
const whitespace = (code: Code) => code === 32 || code === 9 || code === 44;

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
  let previous: Code = null;
  let beforePrevious: Code = null;
  let substantive = false;
  let openWhitespace = false;
  let first = true;
  let invalidClose = false;
  const end: Tokenizer = (inner, done, fail) => {
    invalidClose = false;
    let index = 0;
    const next: State = (code) => {
      if (index === close.length) {
        if (!substantive || (close[0] === 36 && openWhitespace !== whitespace(previous))) {
          invalidClose = true;
          return fail(code);
        }
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
    if (first) {
      openWhitespace = whitespace(code);
      first = false;
    }
    if (code === null || (!display && code < 0)) return nok(code);
    if (
      code === 96 ||
      (code === 47 && previous === 47 && beforePrevious === 58) ||
      (!display && close[0] === 36 && code === 40 && previous === 93)
    )
      return nok(code);
    if (code === close[0] && hasContent) {
      if (dataOpen) {
        effects.exit("f5MathData");
        dataOpen = false;
      }
      return effects.attempt({ tokenize: end }, finished, (current) =>
        code === 92 && !invalidClose ? escape(current) : nok(current),
      )(code);
    }
    if (code === 92) return escape(code);
    return consume(code);
  };
  const escaped: State = (code) => {
    if (code === null) return nok(code);
    consume(code);
    return content;
  };
  const escape: State = (code) => {
    consume(code);
    return escaped;
  };
  const consume: State = (code) => {
    if (code === null) return nok(code);
    hasContent = true;
    beforePrevious = previous;
    previous = code;
    if (
      code !== 92 &&
      code !== null &&
      code >= 0 &&
      !whitespace(code) &&
      (close[1] !== 93 || !(code >= 48 && code <= 57))
    )
      substantive = true;
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
    if (whitespace(code) || code === null || code < 0) return nok(code);
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
  enter(node: Text | MathNode, token: unknown): void;
  exit(token: unknown): void;
  sliceSerialize(token: unknown): string;
  buffer(): void;
  resume(): string;
  stack: (Text | MathNode)[];
}

export function remarkMath(this: unknown) {
  const processor = this as {
    parser: (source: string) => Root;
    data(): {
      micromarkExtensions?: unknown[];
      fromMarkdownExtensions?: unknown[];
    };
  };
  let authoredSource: string | undefined;
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
        const position = token as { start: { offset: number }; end: { offset: number } };
        const source =
          authoredSource?.slice(position.start.offset, position.end.offset) ??
          this.sliceSerialize(token);
        const display = source.startsWith("$$") || source.startsWith("\\[");
        this.enter(
          {
            type: "f5Math",
            value: "",
            data: {
              hName: "code",
              hProperties: {
                className: ["language-math", display ? "math-display" : "math-inline"],
              },
            },
          },
          token,
        );
        this.buffer();
      },
      f5MathData(this: CompileContext, token: unknown) {
        this.enter({ type: "text", value: "" }, token);
      },
    },
    exit: {
      f5Math(this: CompileContext, token: unknown) {
        const value = this.resume();
        const node = this.stack.at(-1)!;
        node.value = value;
        node.data!.hChildren = [{ type: "text", value }];
        this.exit(token);
      },
      f5MathData(this: CompileContext, token: unknown) {
        const position = token as { start: { offset: number }; end: { offset: number } };
        this.stack.at(-1)!.value =
          authoredSource?.slice(position.start.offset, position.end.offset) ??
          this.sliceSerialize(token);
        this.exit(token);
      },
    },
  });
  const parse = processor.parser;
  processor.parser = (source) => {
    authoredSource = source;
    if (!source.includes("|") || !/[$\\]/.test(source)) return parse(source);
    // Read math with table splitting disabled, then protect only its pipes for GFM.
    // This keeps code, link destinations and raw HTML owned by CommonMark.
    const extensions = data.micromarkExtensions;
    type Construct = { name?: string };
    type Extension = { flow?: Record<string, Construct | Construct[] | undefined> };
    data.micromarkExtensions =
      extensions?.map((value) => {
        const extension = value as Extension;
        const flow = extension.flow?.null;
        if (!flow) return value;
        const remaining = (Array.isArray(flow) ? flow : [flow]).filter(
          (item) => item.name !== "table",
        );
        return { ...extension, flow: { ...extension.flow, null: remaining } };
      }) ?? [];
    let tree: Root;
    try {
      tree = parse(source);
    } finally {
      data.micromarkExtensions = extensions ?? [];
    }
    const pipes = new Set<number>();
    const visit = (node: Root | RootContent) => {
      if (
        node.type === "f5Math" &&
        String(node.data?.hProperties?.className).includes("language-math")
      ) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined)
          for (let index = start; index < end; index++) if (source[index] === "|") pipes.add(index);
      } else if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
    const protectedSource = source
      .split("")
      .map((char, index) => (pipes.has(index) ? "\uE000" : char))
      .join("");
    return parse(protectedSource);
  };
}
