export interface ComposerModelMention {
  readonly instanceId: string;
  readonly model: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}
export function collectComposerModelMentions(text: string): readonly ComposerModelMention[] {
  const result: ComposerModelMention[] = [];
  for (const match of text.matchAll(
    /(?<![^\s,(["'])model:([a-zA-Z][a-zA-Z0-9_-]*)\/([^\s,"']+)/gu,
  )) {
    let model = match[2]!;
    while (model) {
      const last = model.at(-1)!;
      const open = last === ")" ? "(" : last === "]" ? "[" : undefined;
      if (!".;:!?".includes(last) && !(open && model.split(open).length < model.split(last).length))
        break;
      model = model.slice(0, -1);
    }
    if (!model) continue;
    const raw = "model:" + match[1] + "/" + model;
    result.push({
      instanceId: match[1]!,
      model,
      raw,
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return result;
}
export const formatComposerModelMention = (instanceId: string, model: string) =>
  "model:" + instanceId + "/" + model;

/** Titles name the model without exposing its reference syntax or instance id. */
export function modelMentionsAsSlugs(value: string): string {
  let result = "";
  let cursor = 0;
  for (const mention of collectComposerModelMentions(value)) {
    result += value.slice(cursor, mention.start) + mention.model;
    cursor = mention.end;
  }
  return result + value.slice(cursor);
}
