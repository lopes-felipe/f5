/**
 * Native window title from the renderer's page title. The page already
 * carries the `(n)` attention prefix and route detail; the shell only adds
 * the profile name, which the Default profile omits.
 */
export function composeNativeWindowTitle(input: {
  readonly pageTitle: string;
  readonly appName: string;
  readonly profile: { readonly name: string; readonly isDefault: boolean };
}): string {
  const page = input.pageTitle.trim();
  const base = page.length > 0 ? page : input.appName;
  return input.profile.isDefault ? base : `${base} · ${input.profile.name}`;
}
