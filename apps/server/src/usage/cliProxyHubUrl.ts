export function cliProxyHubBasePath(pathname: string): string {
  // The web panel URL is also accepted as a hub address.
  return pathname.replace(/(\/management\.html)?\/?$/i, "/");
}
