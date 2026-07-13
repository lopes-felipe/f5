import * as FS from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

const BASELINE_INITIAL_JS_BYTES = 2_511_847;
const REQUIRED_REDUCTION = 0.4;
const MAX_INITIAL_JS_BYTES = Math.floor(BASELINE_INITIAL_JS_BYTES * (1 - REQUIRED_REDUCTION));
const repositoryRoot = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "..");
const webDist = Path.join(repositoryRoot, "apps", "web", "dist");
const indexPath = Path.join(webDist, "index.html");

function assetPathFromUrl(value: string): string | null {
  const pathname = value.split(/[?#]/u, 1)[0];
  if (!pathname?.endsWith(".js") || /^(?:[a-z]+:)?\/\//iu.test(pathname)) return null;
  return Path.join(webDist, pathname.replace(/^\/+/, ""));
}

function initialJavaScriptAssets(html: string): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/giu)) {
    const tag = match[0];
    const tagName = match[1]?.toLowerCase();
    const isEntryScript = tagName === "script" && /\btype=["']module["']/iu.test(tag);
    const isModulePreload = tagName === "link" && /\brel=["']modulepreload["']/iu.test(tag);
    if (!isEntryScript && !isModulePreload) continue;

    const urlMatch = tag.match(
      isEntryScript ? /\bsrc=["']([^"']+)["']/iu : /\bhref=["']([^"']+)["']/iu,
    );
    const assetPath = urlMatch?.[1] ? assetPathFromUrl(urlMatch[1]) : null;
    if (assetPath) paths.add(assetPath);
  }
  return [...paths];
}

if (!FS.existsSync(indexPath)) {
  throw new Error(`Web build output was not found at ${indexPath}. Run the web build first.`);
}

const assets = initialJavaScriptAssets(FS.readFileSync(indexPath, "utf8"));
if (assets.length === 0) {
  throw new Error("Unable to identify the initial JavaScript entry from the built index.html.");
}

const missingAsset = assets.find((asset) => !FS.existsSync(asset));
if (missingAsset) {
  throw new Error(`Initial JavaScript asset does not exist: ${missingAsset}`);
}

const totalBytes = assets.reduce((total, asset) => total + FS.statSync(asset).size, 0);
const reduction = 1 - totalBytes / BASELINE_INITIAL_JS_BYTES;
const reductionPercent = (reduction * 100).toFixed(1);

console.info(
  `Initial web JavaScript: ${totalBytes.toLocaleString()} bytes (${reductionPercent}% below baseline).`,
);

if (totalBytes > MAX_INITIAL_JS_BYTES) {
  throw new Error(
    `Initial web JavaScript exceeds the ${MAX_INITIAL_JS_BYTES.toLocaleString()} byte budget ` +
      `(required reduction: ${(REQUIRED_REDUCTION * 100).toFixed(0)}%).`,
  );
}
