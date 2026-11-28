const path = require("node:path");
const { isBuiltin } = require("node:module");
const { getDefaultConfig } = require("expo/metro-config");

const app = __dirname;
const root = path.resolve(app, "../..");
const config = getDefaultConfig(app);
const appModules = path.join(app, "node_modules");
const rootModules = path.join(root, "node_modules");
config.watchFolders = [root];
config.resolver.nodeModulesPaths = [appModules, rootModules];
config.resolver.disableHierarchicalLookup = true;
config.resolver.unstable_enablePackageExports = true;

const otherApp = path.join(root, "apps") + path.sep;
const { resolveRequest } = config.resolver;
config.resolver.resolveRequest = (context, name, platform) => {
  // The URL polyfill depends on the npm implementation of punycode.
  if (isBuiltin(name) && name !== "punycode")
    throw new Error("Node built-in in mobile bundle: " + name);
  const resolve = resolveRequest ?? context.resolveRequest;
  const fromApp = /^(react|react-native)(\/|$)/.test(name);
  const storePrefix = path.join(rootModules, ".bun") + path.sep;
  // Bun's isolated linker puts a package's dependency links beside the
  // package inside its store entry. Include that directory explicitly.
  const storeEntry = context.originModulePath.startsWith(storePrefix)
    ? context.originModulePath.slice(storePrefix.length).split(path.sep)[0]
    : undefined;
  const origin = fromApp
    ? { ...context, originModulePath: path.join(app, "package.json") }
    : storeEntry
      ? {
          ...context,
          nodeModulesPaths: [
            path.join(storePrefix, storeEntry, "node_modules"),
            ...context.nodeModulesPaths,
          ],
        }
      : context;
  const result = resolve(origin, name, platform);
  if (
    name === "punycode" &&
    (result.type !== "sourceFile" || !result.filePath.includes("node_modules"))
  ) {
    throw new Error("Expected the npm punycode implementation");
  }
  if (
    result.type === "sourceFile" &&
    result.filePath.startsWith(otherApp) &&
    !result.filePath.startsWith(app + path.sep)
  )
    throw new Error("Other app imported in mobile bundle: " + name);
  return result;
};

module.exports = config;
