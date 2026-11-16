import fixture from "./fixtures.json" with { type: "json" };

export { fixture };

/** No clock, randomness, host paths or locale-dependent formatting in fixture content. */
export function messageFixture(index: number) {
  return {
    id: `perf-message-${index}`,
    role: index % 2 ? ("assistant" as const) : ("user" as const),
    text: `Message ${index} (seed ${fixture.seed})\n\n\`\`\`ts\nexport const value = ${index};\n\`\`\`\n`,
    createdAt: new Date(Date.parse(fixture.epoch) + index * 1000).toISOString(),
    attachment: index % fixture.chat.attachmentEvery === 0 ? `image-${index}.png` : null,
    toolOutput: index % fixture.chat.toolEvery === 0 ? "x".repeat(fixture.chat.toolBytes) : null,
  };
}

/** ASCII payloads have exact byte counts; the prefix exercises ANSI, CRLF and Unicode. */
export function terminalChunks(): ReadonlyArray<string> {
  const prefix = "\u001b[32m🦊 café\u001b[0m\r\n";
  const bytes = new TextEncoder().encode(prefix).length;
  return Array.from(
    { length: fixture.terminal.chunksPerBatch },
    (_, i) => prefix + String(i % 10).repeat(fixture.terminal.chunkBytes - bytes - 1) + "\n",
  );
}

/** Assistant delta text with a deterministic length in [minDeltaChars, maxDeltaChars]. */
export function assistantStreamDelta(stream: number, index: number): string {
  const { minDeltaChars, maxDeltaChars } = fixture.assistantStream;
  const mixed = Math.imul(fixture.seed ^ (stream * 7919 + index * 104729), 2654435761) >>> 0;
  const length = minDeltaChars + (mixed % (maxDeltaChars - minDeltaChars + 1));
  const word = `s${stream}d${index} `;
  return word.repeat(Math.ceil(length / word.length)).slice(0, length);
}

export function repositoryFile(index: number) {
  return {
    path: `src/group-${index % fixture.repository.directories}/file-${index}.ts`,
    content: `// fixture ${fixture.seed}\nexport const value${index} = ${index};\n`,
  };
}
