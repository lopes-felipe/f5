// @effect-diagnostics nodeBuiltinImport:off - process bootstrap configures Node's fetch dispatcher.
import { createRequire } from "node:module";
import type * as Undici from "undici";

/** Node 26's bundled undici 8 negotiates HTTP/2 by default. */
export const builtinFetchUsesHttp2 = (version: string | undefined): boolean =>
  Number.parseInt(version ?? "", 10) >= 8;

/** The external undici package, which stays outside the server bundle. */
export function requireUndici(): typeof Undici {
  // A SEA resolves external modules beside the executable. Ordinary ESM/CJS
  // resolves beside its real entry; the dependency stays external to the bundle.
  const require = createRequire(
    process.env.F5_STANDALONE === "1"
      ? process.execPath
      : typeof __filename === "string"
        ? __filename
        : import.meta.url,
  );
  return require("undici") as typeof Undici;
}

/** Keep Node's default fetch off the affected HTTP/2 idle-reaper path. */
export function installHttp1FetchDispatcher(): void {
  const undici = requireUndici();
  // Node's built-in EnvHttpProxyAgent comes from another copy of undici, so
  // instanceof against the external package would discard its proxy choice.
  const usesEnvProxy = undici.getGlobalDispatcher().constructor.name === "EnvHttpProxyAgent";
  undici.setGlobalDispatcher(
    usesEnvProxy
      ? new undici.EnvHttpProxyAgent({
          allowH2: false,
          // This factory also controls a TLS connection to an HTTPS proxy.
          clientFactory: (origin) => new undici.Pool(origin, { allowH2: false }),
        })
      : new undici.Agent({ allowH2: false }),
  );
}

let installed = false;
export function keepOutboundFetchOnHttp1(): void {
  if (!installed && builtinFetchUsesHttp2(process.versions.undici)) {
    installHttp1FetchDispatcher();
    installed = true;
  }
}
