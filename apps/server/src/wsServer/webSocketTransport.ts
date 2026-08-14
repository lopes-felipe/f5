export const WEB_SOCKET_PER_MESSAGE_DEFLATE = {
  threshold: 32 * 1024,
  concurrencyLimit: 4,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  zlibDeflateOptions: {
    level: 3,
    memLevel: 7,
  },
} as const;

export function resolveServerPerMessageDeflate(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): false | typeof WEB_SOCKET_PER_MESSAGE_DEFLATE {
  // Bun's `ws` compatibility shim currently accepts this option but does not
  // negotiate the extension. Disable it explicitly so development logs match
  // the actual wire behavior; Node production and desktop runtimes enable it.
  return versions["bun"] === undefined ? WEB_SOCKET_PER_MESSAGE_DEFLATE : false;
}

export function webSocketRuntimeName(
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): "bun" | "node" {
  return versions["bun"] === undefined ? "node" : "bun";
}
