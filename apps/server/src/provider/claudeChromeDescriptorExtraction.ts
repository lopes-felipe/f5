/**
 * Static Claude in Chrome descriptor extraction from the shipped Claude CLI. The CLI is a
 * Bun single-file executable: its JavaScript chunks follow the bytecode section, each
 * opening with `// @bun @bytecode` and Anthropic's banner. Earlier bytes (bytecode
 * constant pools) can contain stale copies of the same literals, so only the chunk
 * region is scanned. Every anchor is a stable literal; a missing or duplicated anchor
 * is a typed error rather than a guess.
 */
export const CHUNK_MARKER = "// @bun @bytecode\n// Claude Code is a Beta product";
const VERSION_BANNER = "// Version: ";
const HOST_DESCRIPTION = 'description:"Claude Code Browser Extension Native Host"';
const ALLOWED_ORIGINS = "allowed_origins:[";
const WRAPPER_HEADER_LINE = "\n# Chrome native host wrapper script\n";
const MCP_ARGV = 'process.argv[2]==="--claude-in-chrome-mcp"';
const NATIVE_HOST_ARGV = 'process.argv[2]==="--chrome-native-host"';
const NATIVE_HOST_LAUNCH = ',"--chrome-native-host"]';
const MCP_CONFIG = '{type:"stdio",command:process.execPath,args:[';
const SERVER_NAME = '="claude-in-chrome"';
const NATIVE_MESSAGING_PATH = "nativeMessagingPath:[";

export type DescriptorAnchorProblem = "missing" | "duplicated" | "inconsistent" | "malformed";
export class DescriptorAnchorError extends Error {
  constructor(
    readonly anchor: string,
    readonly problem: DescriptorAnchorProblem,
    detail?: string,
  ) {
    super(
      `Claude Chrome descriptor anchor ${JSON.stringify(anchor)} is ${problem}${detail ? `: ${detail}` : ""}.`,
    );
    this.name = "DescriptorAnchorError";
  }
}

export interface DescriptorSource {
  readonly size: number;
  readonly read: (offset: number, length: number) => Promise<Buffer>;
}
export function bufferSource(buffer: Buffer): DescriptorSource {
  return {
    size: buffer.length,
    read: async (offset, length) =>
      buffer.subarray(offset, Math.min(buffer.length, offset + length)),
  };
}

export interface ExtractedClaudeChromeDescriptor {
  readonly cliVersion: string;
  readonly hostName: string;
  readonly hostDescription: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly wrapperPath: ReadonlyArray<string>;
  readonly wrapperHeader: ReadonlyArray<string>;
  readonly nativeHostArgs: ReadonlyArray<string>;
  readonly mcpServerName: string;
  readonly mcpArgs: ReadonlyArray<string>;
  readonly browsers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly nativeMessagingPath: ReadonlyArray<string>;
  }>;
}

const CHUNK_SIZE = 16 * 1024 * 1024;

/** Chunked `Buffer.indexOf` scan; chunks overlap so matches straddling a boundary count once. */
export async function scanOffsets(
  source: DescriptorSource,
  needles: ReadonlyArray<string>,
  start = 0,
  chunkSize = CHUNK_SIZE,
): Promise<Map<string, number[]>> {
  const encoded = needles.map((needle) => [needle, Buffer.from(needle, "latin1")] as const);
  const overlap = Math.max(...encoded.map(([, bytes]) => bytes.length)) - 1;
  const found = new Map(needles.map((needle) => [needle, [] as number[]]));
  for (let offset = start; offset < source.size; offset += chunkSize) {
    const chunk = await source.read(offset, chunkSize + overlap);
    for (const [needle, bytes] of encoded) {
      let index = chunk.indexOf(bytes);
      while (index !== -1) {
        // Matches beginning in the overlap belong to the next chunk.
        if (index < chunkSize) found.get(needle)!.push(offset + index);
        index = chunk.indexOf(bytes, index + 1);
      }
    }
  }
  return found;
}

const text = async (source: DescriptorSource, offset: number, length: number) =>
  (await source.read(Math.max(0, offset), length)).toString("latin1");

function exactlyOne(offsets: Map<string, number[]>, anchor: string): number {
  const hits = offsets.get(anchor) ?? [];
  if (hits.length === 0) throw new DescriptorAnchorError(anchor, "missing");
  if (hits.length > 1)
    throw new DescriptorAnchorError(anchor, "duplicated", `${hits.length} copies`);
  return hits[0]!;
}

function parseStringArray(anchor: string, body: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) values.push(JSON.parse(`"${match[1]}"`) as string);
  if (!values.length) throw new DescriptorAnchorError(anchor, "malformed");
  return values;
}

export async function extractClaudeChromeDescriptor(
  source: DescriptorSource,
): Promise<ExtractedClaudeChromeDescriptor> {
  const markers = (await scanOffsets(source, [CHUNK_MARKER])).get(CHUNK_MARKER)!;
  if (!markers.length) throw new DescriptorAnchorError(CHUNK_MARKER, "missing");
  const regionStart = markers[0]!;
  const offsets = await scanOffsets(
    source,
    [
      VERSION_BANNER,
      HOST_DESCRIPTION,
      ALLOWED_ORIGINS,
      WRAPPER_HEADER_LINE,
      MCP_ARGV,
      NATIVE_HOST_ARGV,
      NATIVE_HOST_LAUNCH,
      MCP_CONFIG,
      NATIVE_MESSAGING_PATH,
    ],
    regionStart,
  );

  // Every chunk carries the same banner; any disagreement means a mixed artifact.
  const banners = offsets.get(VERSION_BANNER)!;
  if (!banners.length) throw new DescriptorAnchorError(VERSION_BANNER, "missing");
  const versions = new Set<string>();
  for (const offset of banners) {
    const line = (await text(source, offset + VERSION_BANNER.length, 64)).split("\n")[0]!;
    versions.add(line.trim());
  }
  if (versions.size !== 1) throw new DescriptorAnchorError(VERSION_BANNER, "inconsistent");
  const cliVersion = [...versions][0]!;
  if (!/^\d+\.\d+\.\d+$/.test(cliVersion))
    throw new DescriptorAnchorError(VERSION_BANNER, "malformed", cliVersion);

  // Manifest object: {name:X,description:"…",path:e,type:"stdio",allowed_origins:[…]}
  const description = exactlyOne(offsets, HOST_DESCRIPTION);
  const originsOffset = exactlyOne(offsets, ALLOWED_ORIGINS);
  if (originsOffset < description || originsOffset - description > 256)
    throw new DescriptorAnchorError(ALLOWED_ORIGINS, "inconsistent", "not in the manifest object");
  const manifestWindow = await text(source, description - 64, 640);
  if (!/type:"stdio"/.test(manifestWindow))
    throw new DescriptorAnchorError(HOST_DESCRIPTION, "malformed", "manifest type");
  const originsBody = /allowed_origins:\[((?:"[^"]*",?)+)/.exec(manifestWindow)?.[1];
  if (!originsBody) throw new DescriptorAnchorError(ALLOWED_ORIGINS, "malformed");
  const allowedOrigins = parseStringArray(ALLOWED_ORIGINS, originsBody);
  if (allowedOrigins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)))
    throw new DescriptorAnchorError(ALLOWED_ORIGINS, "malformed", "origin shape");
  const nameVariable = /\{name:([A-Za-z_$][\w$]*),description:/.exec(manifestWindow)?.[1];
  if (!nameVariable) throw new DescriptorAnchorError("manifest name", "malformed");
  // The host name is a module constant also used for `<host>.json`.
  const hostWindow = await text(source, description - 64 * 1024, 64 * 1024);
  const hostPattern = new RegExp(
    `[,;{ ]${nameVariable.replace(/\$/g, "\\$")}="([a-z0-9_.]+)",[A-Za-z_$][\\w$]*=\`\\$\\{${nameVariable.replace(/\$/g, "\\$")}\\}\\.json\``,
    "g",
  );
  const hosts = [...hostWindow.matchAll(hostPattern)].map((match) => match[1]!);
  if (hosts.length !== 1)
    throw new DescriptorAnchorError("host name", hosts.length ? "duplicated" : "missing");

  // Wrapper: `#!/bin/sh\n# Chrome native host wrapper script\n# Generated … manually\nexec ${…}\n`
  const header = exactlyOne(offsets, WRAPPER_HEADER_LINE);
  const wrapperWindow = await text(source, header - 1024, 2048);
  const headerAt = wrapperWindow.indexOf("`#!/bin/sh" + WRAPPER_HEADER_LINE);
  if (headerAt < 0) throw new DescriptorAnchorError("wrapper header", "malformed", "shebang");
  const wrapperLines = wrapperWindow.slice(headerAt + 1).split("\n");
  const wrapperHeader = wrapperLines.slice(0, 3);
  if (
    wrapperHeader[0] !== "#!/bin/sh" ||
    !wrapperHeader[2]?.startsWith("# Generated by Claude Code") ||
    !wrapperLines[3]?.startsWith("exec ${")
  )
    throw new DescriptorAnchorError("wrapper header", "malformed");
  const wrapperFile = /:[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),"(chrome-native-host)"\)/.exec(
    wrapperWindow,
  );
  const wrapperDirectory = /=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\(\),"([a-z-]+)"\)/.exec(
    wrapperWindow,
  );
  if (!wrapperFile || !wrapperDirectory)
    throw new DescriptorAnchorError("wrapper path", "malformed");

  exactlyOne(offsets, MCP_ARGV);
  exactlyOne(offsets, NATIVE_HOST_ARGV);
  exactlyOne(offsets, NATIVE_HOST_LAUNCH);
  // Several dynamic servers share this shape; keep the one whose argument constant (in
  // the same chunk) is the Chrome MCP flag.
  const configOffsets = offsets.get(MCP_CONFIG)!;
  if (!configOffsets.length) throw new DescriptorAnchorError(MCP_CONFIG, "missing");
  const chromeConfigs: string[][] = [];
  for (const configOffset of configOffsets) {
    const chunkStart = banners.filter((offset) => offset < configOffset).at(-1);
    if (chunkStart === undefined) continue;
    const configWindow = await text(source, chunkStart, configOffset - chunkStart + 256);
    const configMatch =
      /^\{type:"stdio",command:process\.execPath,args:\[([A-Za-z_$][\w$]*)\],scope:"dynamic"\}/.exec(
        configWindow.slice(configOffset - chunkStart),
      );
    if (!configMatch) continue;
    const argVariable = configMatch[1]!.replace(/\$/g, "\\$");
    const values = [
      ...configWindow.matchAll(new RegExp(`[ ,;]${argVariable}="(--[a-z-]+)"`, "g")),
    ].map((match) => match[1]!);
    if (!values.includes("--claude-in-chrome-mcp")) continue;
    // The server name is a constant of the same chunk.
    const names = (configWindow.match(/[ ,;][A-Za-z_$][\w$]*="claude-in-chrome"[,;]/g) ?? [])
      .length;
    if (names !== 1)
      throw new DescriptorAnchorError(
        SERVER_NAME,
        names ? "duplicated" : "missing",
        "in the MCP chunk",
      );
    chromeConfigs.push(values);
  }
  if (chromeConfigs.length !== 1)
    throw new DescriptorAnchorError("mcp config", chromeConfigs.length ? "duplicated" : "missing");
  if (chromeConfigs[0]!.length !== 1) throw new DescriptorAnchorError("mcp args", "inconsistent");

  // Browser table: key:{name:"…",macos:{appName:"…",nativeMessagingPath:[…]},…}, then the order array.
  const pathOffsets = offsets.get(NATIVE_MESSAGING_PATH)!;
  if (!pathOffsets.length) throw new DescriptorAnchorError(NATIVE_MESSAGING_PATH, "missing");
  const tableStart = pathOffsets[0]! - 512;
  const tableWindow = await text(source, tableStart, pathOffsets.at(-1)! - tableStart + 4096);
  const browsers = [
    ...tableWindow.matchAll(
      /([a-z]+):\{name:"([^"]+)",macos:\{appName:"[^"]+",nativeMessagingPath:\[((?:"[^"]*",?)*)\]\}/g,
    ),
  ].map((match) => ({
    id: match[1]!,
    name: match[2]!,
    nativeMessagingPath: parseStringArray(NATIVE_MESSAGING_PATH, match[3]!),
  }));
  if (!browsers.length) throw new DescriptorAnchorError(NATIVE_MESSAGING_PATH, "malformed");
  if (new Set(browsers.map((browser) => browser.id)).size !== browsers.length)
    throw new DescriptorAnchorError(NATIVE_MESSAGING_PATH, "duplicated");
  const keys = new Set(browsers.map((browser) => browser.id));
  const orders = [...tableWindow.matchAll(/[A-Za-z_$][\w$]*=\[((?:"[a-z]+",?)+)\];/g)]
    .map((match) => parseStringArray("browser order", match[1]!))
    .filter((order) => order.length === keys.size && order.every((key) => keys.has(key)));
  if (orders.length !== 1)
    throw new DescriptorAnchorError("browser order", orders.length ? "duplicated" : "missing");
  const byId = new Map(browsers.map((browser) => [browser.id, browser]));

  return {
    cliVersion,
    hostName: hosts[0]!,
    hostDescription: "Claude Code Browser Extension Native Host",
    allowedOrigins,
    wrapperPath: [wrapperDirectory[1]!, wrapperFile[2]!],
    wrapperHeader,
    nativeHostArgs: ["--chrome-native-host"],
    mcpServerName: "claude-in-chrome",
    mcpArgs: ["--claude-in-chrome-mcp"],
    browsers: orders[0]!.map((id) => byId.get(id)!),
  };
}

/** macOS bundle ids for the browsers the CLI registers; unknown keys fail generation. */
export const CLAUDE_CHROME_BROWSER_BUNDLE_IDS: Readonly<Record<string, string>> = {
  chrome: "com.google.Chrome",
  brave: "com.brave.Browser",
  arc: "company.thebrowser.Browser",
  edge: "com.microsoft.edgemac",
  chromium: "org.chromium.Chromium",
  vivaldi: "com.vivaldi.Vivaldi",
  opera: "com.operasoftware.Opera",
};
