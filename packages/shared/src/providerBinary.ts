/** Default command names select F5's bundled runtime; other values are overrides. */
export function isDefaultProviderBinary(
  binaryPath: string | null | undefined,
  defaultCommand: string,
): boolean {
  const normalized = binaryPath?.trim();
  return !normalized || normalized === defaultCommand;
}
